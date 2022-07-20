const functions = require("firebase-functions");
const Firestore = require("@google-cloud/firestore");

const fetch = require("node-fetch");

const puppeteer = require("puppeteer");
var _ = require("lodash")

const uberStuff = require("./uber-stuff")
const zabStuff = require("./zab-stuff")

exports.restaurantDiscoveryUber = uberStuff.restaurantDiscoveryUber;
exports.restaurantDiscoveryZab = zabStuff.restaurantDiscoveryZab;

const PROJECTID = "halal-dining-uk"

var db = new Firestore({
  projectID: PROJECTID,
  timestampsInSnapshots: true,
});

exports.getZabRestaurants = functions.region("us-east4").runWith({ timeoutSeconds: 300, memory: "1GB" }).https.onRequest(async (req, res) => {
  const region = "manchester"
  const destinationURL = `https://www.zabihah.com/search?l=${region}%20uk&k=t=r&s=d&r=64`
  const rawResponse = await fetch(destinationURL)
  const body = await rawResponse.text()
  
  const myRe = /(restLocations = )\[(.|\n)+?(?=\]\;)];/
  const locations = myRe.exec(body)
  
  res.send(locations)
  

  // const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  // const page = await browser.newPage();
  // page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36')

  // var count = 0;
  // var added = 0;

  // try {
  //   // Get Zabihah
  //   const url = `https://www.zabihah.com/search?l=${region}%20uk&k=&t=r&s=t`
  //   await page.goto(url, { waitUntil: 'load', timeout: 0 });
  //   const rs = await page.$x(`//div[@id='header']`)
  //   await page.waitForXPath(`//div[@id='header']`, { timeout: 0 })
  //   count = rs.length
  //   console.debug(`Found ${count} Zabihah restaurants.`)

  //   for (const r of rs) {
  //     // For each element.
  //     let link = await page.evaluate((el) => el.getAttribute("onClick"), r)
  //     let rName = await r.$eval("div.titlebs", tit => tit.textContent);
  //     let address = await r.$eval("div.tinylink", add => add.textContent);
  //     let categories = await r.$$eval("div#alertbox2", tit => tit.map((a) => a.textContent.toLowerCase()));

  //     let data = {}
  //     const d = new Date();

  //     data["name"] = rName
  //     data["address"] = address
  //     data["categories"] = categories
  //     data["url"] = `https://www.zabihah.com${link.match(/'([^']+)'/)[1]}`
  //     data["timeStamp"] = d.getTime()

  //     await db.collection("regions").doc(region).collection("temp-zab").add(data)
  //     added = added + 1
  //   }
  // } catch (error) {
  //   console.debug(error)
  // }
  // console.debug(`Finished adding ${added} out of ${count} Zabihah restaurants`)
  // res.status(200)
});

exports.regionDiscoveryUber = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}")
  .onUpdate(async (change, context) => {

    const region = context.params.region
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

    var count = 0;
    var added = 0;

    try {
      // Get UberEats.
      const url = `https://www.ubereats.com/gb/category/${region}-eng/halal`
      await page.goto(url, { waitUntil: 'networkidle2' });
      const rs = await page.$x(`//*[@id="main-content"]/div[5]/div/div`)
      count = rs.length
      console.debug(`Found ${count} UberEats restaurants.`)
      for (const r of rs) {
        const a = await r.$eval("a", (el) => {
          let data = {}
          const d = new Date();

          data["name"] = el.textContent
          data["url"] = `https://www.ubereats.com${el.getAttribute("href")}`
          data["timeStamp"] = d.getTime()

          return data
        });
        await db.collection("regions").doc(region).collection("temp-uber").add(a)
        added = added + 1
      }
    } catch (error) {
      console.debug("Error getting UberEats restaurants.")
    }
    console.debug(`Finished adding ${added} out of ${count} UberEats restaurants`)
  });

exports.regionDiscoveryZab = functions.region("us-east4").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}")
  .onUpdate(async (change, context) => {

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36')

    var count = 0;
    var added = 0;

    try {
      // Get Zabihah
      const url = `https://www.zabihah.com/search?l=${region}%20uk&k=&t=r&s=t`
      await page.goto(url, { waitUntil: 'load', timeout: 0 });
      const rs = await page.$x(`//div[@id='header']`)
      await page.waitForXPath(`//div[@id='header']`, { timeout: 0 })
      count = rs.length
      console.debug(`Found ${count} Zabihah restaurants.`)

      for (const r of rs) {
        // For each element.
        let link = await page.evaluate((el) => el.getAttribute("onClick"), r)
        let rName = await r.$eval("div.titlebs", tit => tit.textContent);
        let address = await r.$eval("div.tinylink", add => add.textContent);
        let categories = await r.$$eval("div#alertbox2", tit => tit.map((a) => a.textContent.toLowerCase()));

        let data = {}
        const d = new Date();

        data["name"] = rName
        data["address"] = address
        data["categories"] = categories
        data["url"] = `https://www.zabihah.com${link.match(/'([^']+)'/)[1]}`
        data["timeStamp"] = d.getTime()

        await db.collection("regions").doc(region).collection("temp-zab").add(data)
        added = added + 1
      }
    } catch (error) {
      console.debug(error)
    }
    console.debug(`Finished adding ${added} out of ${count} Zabihah restaurants`)
  });

exports.getRegions = functions.https.onRequest(async (req, res) => {
  // Get the regions in the db!
  const ref = await db.collection("regions").get()

  // Build the bundle from the query results
  const bundleBuffer = db.bundle(`regions-data`)
    .add(`latest-regions-data`, ref)
    .build();

  res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800');

  res.end(bundleBuffer);
})