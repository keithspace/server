const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const axios = require("axios");
const base64 = require("base-64");
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

dotenv.config();

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://firestore.googleapis.com/v1/projects/chekr1/databases/(default)"
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = "174379"; // Replace with Paybill or Till number
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = "https://server-iz6n.onrender.com/mpesaCallback"; // Replace with actual callback URL

// Function to get M-Pesa access token
async function getMpesaToken() {
    try {
        const auth = base64.encode(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`);
        const response = await axios.get("https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
            headers: { Authorization: `Basic ${auth}` },
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Error getting M-Pesa token:", error.response?.data || error.message);
        throw new Error("Failed to get access token");
    }
}

// Route to initiate M-Pesa STK Push
app.post("/initiateMpesa", async (req, res) => {
    try {
        const { userId, phoneNumber, amount, cartId, sessionId } = req.body;
        const token = await getMpesaToken();
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
        const password = base64.encode(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`);

        const stkRequest = {
            BusinessShortCode: MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline",
            Amount: amount,
            PartyA: phoneNumber,
            PartyB: MPESA_SHORTCODE,
            PhoneNumber: phoneNumber,
            CallBackURL: CALLBACK_URL,
            AccountReference: "Chekr Order",
            TransactionDesc: "Payment for order",
        };

        const response = await axios.post("https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest", stkRequest, {
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });

        if (response.data.ResponseCode === "0") {
            const merchantRequestId = response.data.MerchantRequestID;
            
            // ✅ Store MerchantRequestID and userId in Firestore before callback
            await db.collection("pendingPayments").doc(merchantRequestId).set({
                userId,
                cartId,
                sessionId,
                amount,
                phoneNumber,
                status: "Pending",
                createdAt: new Date(),
            });

            res.status(200).json({ success: true, message: "STK push sent.", MerchantRequestID: merchantRequestId });
        } else {
            res.status(400).json({ success: false, message: response.data.errorMessage });
        }
    } catch (error) {
        console.error("Error initiating M-Pesa STK:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Failed to initiate M-Pesa payment" });
    }
});
app.post("/mpesaCallback", (req, res) => {
    console.log("📌 M-Pesa Callback Received!");
    console.log("🔹 Full Callback Data:", JSON.stringify(req.body, null, 2));

    const callbackData = req.body;
    if (!callbackData.Body.stkCallback.CallbackMetadata) {
        console.log("❌ No Callback Metadata:", JSON.stringify(callbackData, null, 2));
        return res.json({ success: false, message: "No payment received" });
    }

    // Immediately acknowledge receipt to M-Pesa
    res.json({ success: true, message: "Callback received" });

    // Now process transaction in the background
    (async () => {
        try {
            const phone = callbackData.Body.stkCallback.CallbackMetadata.Item[4]?.Value || "Unknown";
            const amount = callbackData.Body.stkCallback.CallbackMetadata.Item[0]?.Value || 0;
            const trnx_id = callbackData.Body.stkCallback.CallbackMetadata.Item[1]?.Value || "Unknown";
            const merchantRequestId = callbackData.Body.stkCallback.MerchantRequestID;

            console.log({ phone, amount, trnx_id });

            // Fetch the pending payment document
            const paymentDoc = await db.collection("pendingPayments").doc(merchantRequestId).get();
            if (!paymentDoc.exists) {
                console.error("❌ No matching pending payment found.");
                return;
            }

            // Extract data from the pending payment document
            const { userId, cartId, sessionId } = paymentDoc.data(); // Include sessionId here

            // Fetch the cart document
            const cartRef = db.collection("customers").doc(userId).collection("cart").doc(cartId);
            const cartSnapshot = await cartRef.get();

            if (!cartSnapshot.exists) {
                console.error("🛒❌ Cart not found for user:", userId);
                return;
            }

            const cartData = cartSnapshot.data();

            // Store transaction
            const orderData = {
                userId,
                cartId,
                sessionId, // Include sessionId in the order data
                transactionId: trnx_id,
                amount,
                phoneNumber: phone,
                products: cartData.products || [],
                timestamp: new Date(),
                status: "Completed",
                paymentmode: "M-PESA",
            };

            // Save the order to Firestore
            await db.collection("orders").doc(trnx_id).set(orderData);
            console.log("✅ Order saved to Firestore:", orderData);

            // Delete pending payment & cart
            await db.collection("pendingPayments").doc(merchantRequestId).delete();
            await cartRef.delete();
            console.log("🛒✅ Cart and pending payment deleted successfully");
        } catch (error) {
            console.error("❌ Error processing M-Pesa callback:", error.message);
        }
    })();
});

app.post("/testJson", (req, res) => {
    console.log("🔹 Received JSON:", req.body);
    res.json({ message: "JSON received", data: req.body });
});


app.get('/test', (req, res) => {
    res.send('M-Pesa server is working!');
  });
  
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

