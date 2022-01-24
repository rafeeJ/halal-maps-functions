const functions = require("firebase-functions");
const Firestore = require("@google-cloud/firestore");

const puppeteer = require("puppeteer");
const { Client } = require("@googlemaps/google-maps-services-js");

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

    const url = `https://www.ubereats.com/gb/category/${region}-eng/halal`
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();

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
      await db.collection("regions").doc(region).collection("temp").add(a)
    }
  });

exports.restaurantDiscovery = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}/temp/{restaurant}")
  .onCreate(async (snapshot, context) => {

    // Target information.
    var address;
    var categories;

    // Get the data we are working with.
    const restaurantData = snapshot.data();
    const url = restaurantData.url

    // Launch puppeteer
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 })
    await page.goto(url, { waitUntil: 'networkidle2' });

    try {
      // Close Modal
      const modalClose = await page.$x("/html/body/div[1]/div[1]/div/div[5]/div/div/div[2]/div[2]/button")
      await modalClose[0].click()
    } catch (error) {
      console.debug("Error closing modal.")
    }

    try {
      // Close Cookie banner
      const cookieBanner = await page.$x(`//*[@id="cookie-banner"]/div/div/div[2]/button[2]`)
      await cookieBanner[0].click()
    } catch (error) {
      console.debug("Error closing cookie banner.")
    }

    try {
      // Try to click the button.
      const moreInfo = await page.$x(`//a[contains(., "More")]`);
      await moreInfo[0].click();
      await page.waitForXPath('//div[@role="dialog"]')
    } catch (error) {
      console.debug("Failed to get more info.")
    }

    try {
      // Get address.
      const moreInfoText = await page.$x(`//div[@role="dialog"]/*/button`)
      address = await moreInfoText[1].$eval("div", (el) => el.textContent)
    } catch (error) {
      console.debug("Failed to get the address.")
    }

    try {
      // Get categories.
      const catEle = await page.$x(`//div[@role='dialog']/div/div[2]/div`);
      let cats = await page.evaluate(el => el.textContent, catEle[1])
      categories = cats.split("•");
    } catch (error) {
      console.debug("Failed to get the categories.")
    }

    var places;

    // Use the name and address to get geolocation.
    if (process.env.FUNCTIONS_EMULATOR == true || process.env.FUNCTIONS_EMULATOR == "true") {
      console.debug("Not using API")
    } else {
      console.debug("Using Maps API")
      const client = new Client({});

      places = await client
        .findPlaceFromText({
          params: {
            key: functions.config().map.key,
            fields: ["name", "geometry/location", "formatted_address", "place_id", "type"],
            input: `${restaurantData.name} ${address}`,
            inputtype: "textquery"
          }
        })

    }
    
    try {
      var data;
      if (places.data.candidates[0].types.includes("food")) {
        data = places.data.candidates[0]
        await db.collection("regions").doc(context.params.region).collection("restaurants").doc(data.place_id).set({ restaurantData: data, categories: categories })
      } else {
        await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).set({ address: address , categories: categories })
      }
    } catch (error) {
      console.debug("Nothing to add")
      await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).set({ address: address , categories: categories })
    }

    // var data = places.data.candidates[0].types.includes("food") ? places.data.candidates[0] : ""

    // if (data.data.candidates) {
    //   await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).update({ restaurantData: data.data.candidates[0] })
    // } else {
    //   await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).update({ restaurantData: { address: moreInfoString, categories: categories } })
    // }

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