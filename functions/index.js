const functions = require("firebase-functions");
const Firestore = require("@google-cloud/firestore");

const fetch = require("node-fetch");

const puppeteer = require("puppeteer");
var _ = require("lodash")

const uberStuff = require("./uber-stuff")

exports.restaurantDiscoveryUber = uberStuff.restaurantDiscoveryUber;

const PROJECTID = "halal-dining-uk"

var db = new Firestore({
  projectID: PROJECTID,
  timestampsInSnapshots: true,
});

exports.getZabRestaurants = functions.region("us-east4").runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {

  const destinationURL = `https://www.zabihah.com/sub/United-Kingdom/North-West/Greater-Manchester/ffn3Em1F05`
  const rawResponse = await fetch(destinationURL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
    }
  });

  const body = await rawResponse.text()

  if (body.length === -1) {
    res.send(404)
  }
  console.debug("We have a response")

  if (body.indexOf('restLocations') === -1) {
    console.debug("Website is messed up, leave,")
    res.send(404)
  } else {
    console.debug("We have some locations!");

    const myRe = /restLocations(.*)\];/gmsi
    var results = myRe.exec(body);
    results = results[0].split('];')[0]

    const restaurantList = [...results.matchAll(/{[^}]+}/gmis)]

    for (const val of restaurantList) {
      let restaurant = val[0]
      const urlRe = /(\/biz\/.*)"/gmsi
      var url = urlRe.exec(restaurant)

      let data = { url: url[1] }
      await db.collection("regions").doc('manchester').collection("temp-zab").add(data)
    }
  }
  res.send(200)
});


exports.processURL = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}/temp-zab/{restaurant}")
  .onCreate(async (snapshot, context) => {
    const url = snapshot.data().url

    const oneRest = await fetch(`https://www.zabihah.com${url}`)
    const bodyRest = await oneRest.text()

    const restRe = /<script type="application\/ld\+json">(.*)<\/script/gmis
    let jsonEsq = restRe.exec(bodyRest)
    jsonEsq = jsonEsq[0].split('</script>')[0]
    jsonEsq = jsonEsq.replace('<script type="application/ld+json">', '')
    restaurantJSON = JSON.parse(jsonEsq)

    await db.collection("regions").doc(context.params.region).collection("restaurants").doc().set(restaurantJSON)
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