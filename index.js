const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);
// const serviceAccount = require("./firebase-admin-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection string
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uo9cj9u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// const uri = "mongodb://localhost:27017/";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const parcelCollection = client.db("ParcelDB").collection("parcels");
    const paymentCollection = client.db("ParcelDB").collection("payments");
    const userCollection = client.db("ParcelDB").collection("users");
    const ridersCollection = client.db("ParcelDB").collection("riders");
    const trackingCollection = client.db("ParcelDB").collection("tracking");

    // Custom Middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized Access!!" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized Access!!" });
      }
      // Verify this token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden Access!!" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "admin") {
        res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "rider") {
        res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };
    const verifyUser = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "user") {
        res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // Users Collection Apis:
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        const updateInfo = {
          $set: { last_log_in: req.body.last_log_in },
        };
        await userCollection.updateOne({ email }, updateInfo);

        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // ✅ Get all parcels created by a specific user (Track a Package)
    app.get("/user/parcels", async (req, res) => {
      try {
        const { email } = req.query;

        const query = { created_by: email };
        const result = await parcelCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        // console.error("Error fetching user parcels:", error);
        res.status(500).send({ message: "Failed to fetch parcels" });
      }
    });

    // Assuming you already have:
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await userCollection.findOne({ email });
        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        return res.send({ role: user.role || "user" });
      } catch (error) {
        // console.error("Error fetching user role:", error);
        return res.status(500).send({ message: "Failed to fetch user role" });
      }
    });

    // GET /users/search?email=ali
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { email } = req.query;
        let query = {};

        if (email) {
          query.email = { $regex: email, $options: "i" };
        }

        const users = await userCollection
          .find(query, {
            projection: { email: 1, created_at: 1, last_log_in: 1, role: 1 },
          })
          .sort({ created_at: -1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        // console.error(error);
        res.status(500).send({ message: "Failed to search users", error });
      }
    });

    // PATCH: update user role
    app.patch("/users/:id/role", async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;

        const validRoles = ["user", "admin"];
        if (!validRoles.includes(role)) {
          return res
            .status(400)
            .send({ message: "Invalid role. Must be 'user' or 'admin'." });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );

        if (result.modifiedCount > 0) {
          res.send({ success: true, message: `Role updated to ${role}` });
        } else {
          res.status(404).send({
            success: false,
            message: "User not found or role unchanged",
          });
        }
      } catch (error) {
        // console.error("Error updating user role:", error);
        res.status(500).send({ message: "Failed to update user role", error });
      }
    });

    // GET API: Get all pending delivery tasks for a rider
    app.get("/rider/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }
        const updateDoc = {
          "assigned_rider.email": email,
          delivery_status: { $in: ["assigned", "transit"] },
        };

        const pendingParcels = await parcelCollection
          .find(updateDoc)
          .sort({ updated_at: -1 })
          .toArray();

        if (pendingParcels.length === 0) {
          return res
            .status(404)
            .send({ message: "No pending deliveries found" });
        }
        res.send(pendingParcels);
      } catch (error) {
        // console.error("Error fetching pending parcels:", error);
        res
          .status(500)
          .send({ message: "Failed to fetch pending deliveries", error });
      }
    });

    // PATCH: /parcels/:id/status
    app.patch("/parcels/:id/status", async (req, res) => {
      const { id } = req.params;
      const { delivery_status } = req.body;

      try {
        const updated = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { delivery_status, updated_at: new Date().toISOString() } }
        );

        res.send({ success: true, updated });
      } catch (err) {
        res.status(500).send({ message: "Failed to update parcel status" });
      }
    });

    // Get delivered parcels for a specific rider by email
    app.get(
      "/rider/deliveredParcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;
          const query = {
            "assigned_rider.email": email,
            delivery_status: "delivered",
          };
          const parcels = await parcelCollection
            .find(query)
            .sort({ updated_at: -1 })
            .toArray();

          res.status(200).send(parcels);
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to fetch delivered parcels", error });
        }
      }
    );

    // Riders Collection Apis:
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        // console.error("❌ Failed to fetch pending riders:", error);
        res
          .status(500)
          .send({ message: "Failed to fetch pending riders", error });
      }
    });

    // Approve or Reject Rider (Update status)
    app.patch("/riders/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { status, email } = req.body;
        // console.log(id, status, email);

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status === "approved" ? "approved" : "rejected",
            updated_at: new Date(),
          },
        };
        const result = await ridersCollection.updateOne(query, updateDoc);
        res.send(result);

        if (status === "approved") {
          try {
            const userQuery = { email };
            const userUpdateDoc = {
              $set: {
                role: "rider",
              },
            };
            const roleResult = await userCollection.updateOne(
              userQuery,
              userUpdateDoc
            );
            // res.send(roleResult);
            // console.log(roleResult.modifiedCount);
          } catch (error) {
            // console.log(error);
          }
        }
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to update rider status",
          error,
        });
      }
    });

    // Get Active Riders
    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        // console.log(req.query);
        const status = req.query.status;
        const name = req.query.name;

        let query = {};
        if (status) query.status = status;
        if (name) query.name = { $regex: name, $options: "i" };

        const riders = await ridersCollection
          .find(query)
          .sort({ created_at: -1 })
          .toArray();

        res.send(riders);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch riders", error });
      }
    });

    // Deactivate Rider
    app.patch("/riders", async (req, res) => {
      try {
        const id = req.body.rider._id;
        // console.log(id);

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { status: "deactivated", updated_at: new Date().toISOString() },
        };

        const result = await ridersCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        // console.error("Deactivate rider error:", error);
        res.status(500).send({ message: "Failed to deactivate rider", error });
      }
    });

    // PATCH /parcels/:id/assign-rider
    app.patch("/parcels/:id/assign-rider", async (req, res) => {
      try {
        const { id } = req.params;
        const { riderId } = req.body;

        const rider = await ridersCollection.findOne({
          _id: new ObjectId(riderId),
        });
        if (!rider) {
          return res
            .status(404)
            .send({ success: false, message: "Rider not found" });
        }
        const updateDoc = {
          $set: {
            assigned_rider: {
              riderId: rider._id,
              name: rider.name,
              email: rider.email,
              contact: rider.contact,
              region: rider.region,
            },
            delivery_status: "assigned",
            updated_at: new Date().toISOString(),
          },
        };
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ success: false, message: "Parcel not found" });
        }

        res.send({
          success: true,
          message: "Rider assigned successfully",
          assignedRider: rider,
        });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Failed to assign rider" });
      }
    });

    // Get parcel by user id
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        // console.log(id);
        const query = { _id: new ObjectId(id) };
        const parcel = await parcelCollection.findOne(query);

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }
        res.send(parcel);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch parcel", error });
      }
    });

    // Get parcels by user email (latest first)
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;
        // console.log(userEmail);
        let query = {};
        if (email) {
          query = { created_by: email };
        }
        if (payment_status) {
          query.payment_status = payment_status;
        }
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

        const parcels = await parcelCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();
        res.status(200).send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch parcels", error });
      }
    });

    // Post a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        if (!newParcel || Object.keys(newParcel).length === 0) {
          return res.status(400).send({ message: "Parcel data is required" });
        }

        // Always store date as real Date object
        newParcel.creation_date = new Date().toISOString();

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add parcel", error });
      }
    });

    // Get Dashboard Data For Rider
    app.get(
      "/parcels/rider/status-count",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { email } = req.query;

        const pipeline = [
          {
            $match: {
              "assigned_rider.email": email,
              delivery_status: { $ne: "not_collected" },
            },
          },
          {
            $group: {
              _id: "$delivery_status",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              status: "$_id",
              count: 1,
              _id: 0,
            },
          },
        ];

        const result = await parcelCollection.aggregate(pipeline).toArray();
        res.send(result);
      }
    );

    // Get Dashboard Data for User
    app.get(
      "/user/parcels/summary/:email",
      verifyFBToken,
      verifyUser,
      async (req, res) => {
        const email = req.params.email;

        const pipeline = [
          {
            $match: { created_by: email },
          },
          {
            $group: {
              _id: null,
              totalCreated: { $sum: 1 },
              totalUnpaid: {
                $sum: {
                  $cond: [{ $eq: ["$payment_status", "unpaid"] }, 1, 0],
                },
              },
              totalDelivered: {
                $sum: {
                  $cond: [{ $eq: ["$delivery_status", "delivered"] }, 1, 0],
                },
              },
              totalCostPaid: {
                $sum: {
                  $cond: [{ $eq: ["$payment_status", "paid"] }, "$cost", 0],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              totalCreated: 1,
              totalUnpaid: 1,
              totalDelivered: 1,
              totalCostPaid: 1,
            },
          },
        ];

        const result = await parcelCollection.aggregate(pipeline).toArray();
        res.send(
          result[0] || {
            totalCreated: 0,
            totalUnpaid: 0,
            totalDelivered: 0,
            totalCostPaid: 0,
          }
        );
      }
    );

    // Get Dashboard Data For Admin.
    app.get(
      "/admin/dashboard/summary",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const totalActiveRiders = await ridersCollection.countDocuments({
            status: "approved",
          });
          const totalNotAssignedParcels = await parcelCollection.countDocuments(
            {
              $and: [
                { payment_status: "paid" },
                { delivery_status: "not_collected" },
              ],
            }
          );
          const totalDelivered = await parcelCollection.countDocuments({
            delivery_status: "delivered",
          });

          // (Placeholder) totalEarn will be added later
          const totalEarn = 0;
          res.send({
            totalActiveRiders,
            totalNotAssignedParcels,
            totalDelivered,
            totalEarn,
          });
        } catch (error) {
          //   console.error("Error in admin dashboard summary:", error);
          res.status(500).send({
            message: "Failed to load dashboard summary",
            error: error.message,
          });
        }
      }
    );
    app.get(
      "/admin/parcels/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcels = await parcelCollection
            .find({
              payment_status: "paid", // ✅ only paid
              delivery_status: {
                $in: ["not_collected", "assigned", "transit", "delivered"],
              },
            })
            .sort({ updated_at: -1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          //   console.error("Error fetching parcels:", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );

    // Delete a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.status(200).send({ message: "Parcel deleted successfully" });
      } catch (error) {
        res.status(500).send({ message: "Failed to delete parcel", error });
      }
    });

    // POST: Add a new tracking record
    app.post("/tracking", async (req, res) => {
      try {
        const {
          tracking_id,
          parcel_id,
          status,
          massage,
          update_by = "",
        } = req.body;
        const tracking = {
          parcel_id: new ObjectId(parcel_id),
          tracking_id,
          status,
          update_by,
          massage,
          created_at: new Date().toISOString(),
        };
        const result = await trackingCollection.insertOne(tracking);
        // console.log(result);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to create tracking", error });
      }
    });

    // Payment Get Api by user email
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        // console.log(userEmail);
        const payments = await paymentCollection
          .find({ email })
          .sort({ paid_at: -1 })
          .toArray();
        // console.log(payments);
        res.send(payments);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch payments", error });
      }
    });

    // Payment Post Api
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, transactionId, paymentMethod } =
          req.body;

        // Update Payment Status
        const filter = { _id: new ObjectId(parcelId) };
        const update = { $set: { payment_status: "paid" } };
        await parcelCollection.updateOne(filter, update);

        const paymentRecord = {
          parcelId: new ObjectId(parcelId),
          email,
          amount,
          transactionId,
          paymentMethod,
          status: "success",
          paid_at_string: new Date().toISOString(),
          paid_at: new Date().toISOString(),
        };
        const result = await paymentCollection.insertOne(paymentRecord);

        res.status(201).send({ message: "Payment recorded", result });
      } catch (error) {
        res.status(500).send({ message: "Failed to record payment", error });
      }
    });

    // Step - 3: Create Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amountInCents = req.body.amountInCents;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).send({ message: "Payment initiation failed", error });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    // console.error("❌ MongoDB connection error:", error);
  }
}
run().catch();

// Default route
app.get("/", (req, res) => {
  res.send("🚚 Parcel server is running");
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running on PORT: ${port}`);
});
