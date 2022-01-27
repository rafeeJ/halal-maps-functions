const functions = require("firebase-functions");
const { Client, Language } = require("@googlemaps/google-maps-services-js");
const puppeteer = require("puppeteer");
const Firestore = require("@google-cloud/firestore");

const functionConfig = () => {
    if (process.env.RUN_LOCALLY) {
        const fs = require('fs');
        return JSON.parse(fs.readFileSync('.env.json'));
    } else {
      return functions.config();
    }
};

const PROJECTID = "halal-dining-uk"

const db = new Firestore({
  projectID: PROJECTID,
  ignoreUndefinedProperties: true,
  timestampsInSnapshots: true,
});

exports.restaurantDiscoveryZab = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}/temp-zab/{restaurant}")
    .onCreate(async (snapshot, context) => {

        // Target information.
        var address;

        // Get the data we are working with.
        const restaurantData = snapshot.data();

        var zabData = {
            url: restaurantData.url,
            categories: restaurantData.categories
        }

        // Use the name and address to get geolocation.
        if (process.env.FUNCTIONS_EMULATOR == true || process.env.FUNCTIONS_EMULATOR == "true") {
            console.debug("Not using API")
            try {
                await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).set({ address: address, zabData: zabData })
            } catch (error) {
                console.debug("Failed adding to db (LOCAL)")
                console.debug(error)
            }
        } else {
            console.debug("Using Maps API")
            const client = new Client({});

            var places = await client
                .findPlaceFromText({
                    params: {
                        key: functionConfig().map.key,
                        fields: ["name", "geometry/location", "formatted_address", "place_id", "type"],
                        input: `${restaurantData.name} ${restaurantData.address}`,
                        inputtype: "textquery",
                        language: Language.en_GB
                    }
                })
            
            var bestRestaurant = places.data.candidates[0]

            if (bestRestaurant.types.includes("food")) {
                try {
                    await db.collection("regions").doc(context.params.region).collection("restaurants").doc(bestRestaurant.place_id).set({ restaurantData: bestRestaurant, zabData: zabData }, {merge: true})
                } catch (error) {
                    console.debug("Failed adding to db (PROD)")
                    console.debug(error)
                }
            } else {
                // Highest chance is probably not the correct one - leave it.
                console.debug("Leave it fam")
            }

        }
    });