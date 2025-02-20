const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const dotenv = require("dotenv");

dotenv.config();

admin.initializeApp({
    credential: admin.credential.cert(require("./firebase-admin.json")),
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// M-Pesa Callback URL
app.post("/mpesaCallback", async (req, res) => {
    try {
        const callbackData = req.body;
        console.log("Received M-Pesa callback:", callbackData);

        if (!callbackData || !callbackData.Body) {
            return res.status(400).send("Invalid callback data");
        }

        const transaction = callbackData.Body.stkCallback;
        const resultCode = transaction.ResultCode;
        const transactionId = transaction.MerchantRequestID;
        const amount = transaction.CallbackMetadata.Item.find(item => item.Name === "Amount")?.Value;
        const phoneNumber = transaction.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber")?.Value;
        const userId = req.query.userId;

        if (resultCode === 0) {
            // Successful Payment
            const cartRef = db.collection("customers").doc(userId).collection("cart").doc("activeCart");
            const cartSnapshot = await cartRef.get();

            if (!cartSnapshot.exists) {
                return res.status(400).send("Cart not found");
            }

            const cartData = cartSnapshot.data();
            const products = cartData.products || [];

            // Create Order in Firestore
            const orderRef = db.collection("orders").doc();
            await orderRef.set({
                cart_id: "activeCart",
                user_id: userId,
                payment_mode: "M-Pesa",
                amount_paid: amount,
                phone_number: phoneNumber,
                status: "Paid",
                timestamp: new Date(),
                products: products
            });

            // Delete cart after payment
            await cartRef.delete();

            return res.status(200).send("Payment successful, order created.");
        } else {
            console.log("Payment failed");
            return res.status(400).send("Payment failed.");
        }
    } catch (error) {
        console.error("Error processing M-Pesa callback:", error);
        res.status(500).send("Server error.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

