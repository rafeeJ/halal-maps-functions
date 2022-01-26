const functions = require("firebase-functions");
const { Client, Language } = require("@googlemaps/google-maps-services-js");
const puppeteer = require("puppeteer");
const Firestore = require("@google-cloud/firestore");

const PROJECTID = "halal-dining-uk"

const db = new Firestore({
  projectID: PROJECTID,
  timestampsInSnapshots: true,
});

exports.restaurantDiscoveryUber = functions.region("europe-west2").runWith({ timeoutSeconds: 300, memory: "1GB" }).firestore.document("regions/{region}/temp-uber/{restaurant}")
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
            categories = cats.split("•").map(ele => ele.trim())
        } catch (error) {
            console.debug("Failed to get the categories.")
        }

        var uberData = {
            url: url,
            categories: categories,
        }

        // Use the name and address to get geolocation.
        if (process.env.FUNCTIONS_EMULATOR == true || process.env.FUNCTIONS_EMULATOR == "true") {
            console.debug("Not using API")
            try {
                await db.collection("regions").doc(context.params.region).collection("restaurants").doc(context.params.restaurant).set({ address: address, uberData: uberData })
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
                        key: functions.config().map.key,
                        fields: ["name", "geometry/location", "formatted_address", "place_id", "type"],
                        input: `${restaurantData.name} ${address}`,
                        inputtype: "textquery",
                        language: Language.en_GB
                    }
                })
            
            var bestRestaurant = places.data.candidates[0]
            
            if (bestRestaurant.types.includes("food")) {
                try {
                await db.collection("regions").doc(context.params.region).collection("restaurants").doc(bestRestaurant.place_id).set({ restaurantData: data, uberData: uberData }, {merge: true})
                } catch (error) {
                    console.debug("Failed adding to db (PROD)")
                }
            } else {
                // Highest chance is probably not the correct one - leave it.
                console.debug("Leave it fam")
            }
        }
    });