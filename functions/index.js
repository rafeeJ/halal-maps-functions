const functions = require("firebase-functions");
const Firestore = require("@google-cloud/firestore");
const { Client, Language, PlaceData } = require("@googlemaps/google-maps-services-js");
const geofire = require('geofire-common');

const fetch = require("node-fetch");
var _ = require("lodash")

const PROJECTID = "halal-dining-uk"

/** @type {Firestore} */
var db = new Firestore({
  projectID: PROJECTID,
  timestampsInSnapshots: true,
});

const scrapeZabPage = async (url) => {
  const rawResponse = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
    }
  })

  const body = await rawResponse.text()

  if (body.length === -1) {
    return null
  }
  console.debug("We have a response")

  if (body.indexOf('restLocations') === -1) {
    console.debug("Website is messed up, leave,")
    return null
  } else {
    console.debug("We have some locations!");

    const myRe = /restLocations(.*)\];/gmsi
    var results = myRe.exec(body);
    results = results[0].split('];')[0]

    const restaurantList = [...results.matchAll(/{[^}]+}/gmis)].map(val => val[0])
    return restaurantList
  }
}

const lookForFlags = (text) => {
  let m = {}

  if (text.toLowerCase().indexOf('alcohol-free') > -1) {
    // no alcohol served.
    m['servesAlcohol'] = false
  } else {
    // alcohol may be served.
    m['servesAlcohol'] = true
  }

  if (text.toLowerCase().indexOf('full halal menu') > -1) {
    // full halal menu
    m['fullHalal'] = true
  } else {
    // Non-halal options.
    m['fullHalal'] = false
  }
  return m
}

const evaluatePlaces = (placeArray) => {
  /** @type {PlaceData} */
  const mostLikley = placeArray[0]
  if (mostLikley.types.includes("food")) {
    return mostLikley
  } else {
    return null
  }
}

exports.generateRestaurants = functions.region("europe-west2")
  .runWith({ timeoutSeconds: 180, memory: "256MB" })
  .firestore.document("regions/{region}")
  .onCreate(async (snapshot, context) => {

    const regionName = context.params.region;

    var regionData = snapshot.data();

    /** @type {Array<string>} */
    var areasToScrape = regionData.areas;

    for (const area of areasToScrape) {
      // area should be a URL to scrape!
      const areaRestaurants = await scrapeZabPage(area)

      for (const val of areaRestaurants) {

        const urlRe = /(\/biz\/.*)"/gmsi
        var url = urlRe.exec(val)
        var restaurantUrl = url[1]

        let data = { url: restaurantUrl }

        var docRef = db.collection("regions").doc(regionName).collection("temp")
        var doc = await docRef.where('url', '==', restaurantUrl).get()

        if (doc.empty) {
          await db.collection("regions").doc(regionName).collection("temp").add(data)
        }
      }
    }
  });

exports.processURL = functions.region("europe-west2")
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .firestore.document("regions/{region}/temp/{restaurant}")
  .onCreate(async (snapshot, context) => {
    const url = snapshot.data().url

    const restaurantData = await fetch(`https://www.zabihah.com${url}`)
    const body = await restaurantData.text()


    const restRe = /<script type="application\/ld\+json">(.*)<\/script/gmis
    let jsonEsq = restRe.exec(body)
    jsonEsq = jsonEsq[0].split('</script>')[0]
    jsonEsq = jsonEsq.replace('<script type="application/ld+json">', '')
    restaurantJSON = JSON.parse(jsonEsq)

    // Deal with this stuff.
    var flags = lookForFlags(body)
    flags.categories = restaurantJSON.servesCuisine

    if (process.env.TEST_MAPS === 'true') {
      console.debug("Using maps API")
      const client = new Client({});

      var places = await client.findPlaceFromText({params: {
        key: process.env.MAPS_API,
        inputtype: "textquery",
        input: `${restaurantJSON.name} ${restaurantJSON.address.streetAddress} ${restaurantJSON.address.postalCode}`,
        language: Language.en_GB,
        fields: ["name", "place_id", "type"],
      }})
      
      var data = places.data.candidates
      var restaurantToAdd = null;
      
      if (data.length > 0) {
        restaurantToAdd = evaluatePlaces(data)
      } else {
        console.debug(`url to retry: ${url}`)
        console.debug("no data, printing for debug reasons, status:")
        console.debug(places.data.status)
        console.debug("===============")
        console.debug(data)
      }

      if (restaurantToAdd !== null) {
        var dataToPost = { ...flags, ...restaurantToAdd}
        await db.collection("regions").doc(context.params.region).collection("restaurants").doc(restaurantToAdd.place_id).set(dataToPost)
      } else {
        console.debug("Failed to add to DB.")
      }
    } else {
      var dataToPost = { ...restaurantJSON, ...flags }
      await db.collection("regions").doc(context.params.region).collection("restaurants").doc().set(dataToPost)
    }


  });

exports.restaurantFromPlaceID = functions.region("europe-west2")
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .firestore.document("regions/{region}/restaurants/{placeID}")
  .onCreate(async (docSnapshot, context) => {
    const client = new Client({});

    var placeDetails;

    const params = {
      key: process.env.MAPS_API,
      place_id: context.params.placeID,
      language: Language.en_GB,
      fields: ["name", "geometry/location", "formatted_address", "type", "business_status", "formatted_phone_number", "opening_hours/weekday_text", "website", "price_level", "rating", "address_components"]
    }

    if (process.env.TEST_MAPS === 'true') {
      
      try {
        
        placeDetails = await client.placeDetails({ params: params })
        var deets = placeDetails.data.result
        deets.geometry.location.hash = geofire.geohashForLocation([deets.geometry.location.lat, deets.geometry.location.lng])
        
        if (deets.business_status === "OPERATIONAL") {  
          docSnapshot.ref.set(deets, { merge: true})
        } else {
          console.log("Restaurant is closed now.")
          docSnapshot.ref.delete()
        }
      
      } catch (error) {
        
        console.debug(error.response.data)

      }
    } else {
      console.debug("We are not using the map API right now.")
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