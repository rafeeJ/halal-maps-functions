const functions = require("firebase-functions");
const Firestore = require("@google-cloud/firestore");

const puppeteer = require("puppeteer");
const { Client } = require("@googlemaps/google-maps-services-js");
var _ = require("lodash")

const uberStuff = require("./uber-stuff")
const zabStuff = require("./zab-stuff")

exports.restaurantDiscoveryUber = uberStuff.restaurantDiscoveryUber;
exports.restaurantDiscoveryZab = zabStuff.restaurantDiscoveryZab;

const PROJECTID = "halal-dining-uk"

const db = new Firestore({
  projectID: PROJECTID,
  timestampsInSnapshots: true,
});

// exports.restaurantDiscovery = functions
//   .runWith({ timeoutSeconds: 300, memory: "1GB" })
//   .pubsub.schedule("0 0 1 * *")
//   .timeZone("Europe/London")
//   .region("europe-west2")
//   .onRun(async (context) => {
//     const regions = [];

//     // Get the regions in the db!
//     await db.collection("regions").get()
//       .then((querySnapshot) => {
//         querySnapshot.forEach((doc) => {
//           regions.push(doc.data().region);
//         });
//       });
//     const d = new Date();
//     // For each region, update it to indicate that we are running a batch job.
//     regions.forEach((region) => {
//       const ref = db.collection("regions").doc(region);
//       ref.update({ timeStamp: d })
//     })
//     res.status(200)
//   });

exports.webhook = functions.region("europe-west2").https.onRequest(async (req, res) => {
  const regions = [];

  // Get the regions in the db!
  await db.collection("regions").get()
    .then((querySnapshot) => {
      querySnapshot.forEach((doc) => {
        regions.push(doc.data().region);
      });
    });
  const d = new Date();

  // For each region, update it to indicate that we are running a batch job.
  regions.forEach((region) => {
    const ref = db.collection("regions").doc(region);
    ref.update({ timeStamp: d });
  })
  res.status(200).send("Completed")
});

exports.regionDiscovery = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}")
  .onUpdate(async (change, context) => {

    const region = context.params.region
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    try {
      // Get UberEats.
      const url = `https://www.ubereats.com/gb/category/${region}-eng/halal`
      await page.goto(url, { waitUntil: 'networkidle2' });
      const rs = await page.$x(`//*[@id="main-content"]/div[5]/div/div`)
      
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
      }
    } catch (error) {
      console.debug("Error getting UberEats restaurants.")
    }

    try {
      // Get Zabihah
      const url = `https://www.zabihah.com/search?l=${region}%20uk&k=&t=r&s=t`
      await page.goto(url, { waitUntil: 'networkidle2' });
      const rs = await page.$x(`/html/body/table[1]/tbody/tr/td[1]/table[11]/tbody/tr/td/table/tbody/tr/td/div[@id='header']`)
      
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
      }
    } catch (error) {
      console.debug(error)
    }
      
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


exports.createBundle = functions.https.onRequest(async (request, response) => {
  var region = request.params[0].replace("createBundle/", "");
  if (!region) {
    console.debug("There was no region, defaulting to the request body.");
    region = request.body.data.region
    console.debug(`region = ${region}`)
  } else {
    console.debug(`region = ${region}`)
  }

  var regionalRestaurants;
  if (region) {
    // Query the 50 latest stories
    regionalRestaurants = await db.collection("regions")
      .doc(region).collection("restaurants")
      .get();
  } else {
    response.status(404).send("Failed.")
  }

  // Build the bundle from the query results
  const bundleBuffer = db.bundle(`restaurants-${region}`)
    .add(`latest-${region}-restaurant-query`, regionalRestaurants)
    .build();

  // Cache the response for up to 5 minutes;
  // see https://firebase.google.com/docs/hosting/manage-cache
  response.set('Cache-Control', 'public, max-age=86400, s-maxage=604800');

  response.end(bundleBuffer);
});