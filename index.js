const admin = require("firebase-admin");
const express = require("express");
const app = express();

const dbURL = "https://fir-33a57-default-rtdb.firebaseio.com";
const saContent = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!saContent) {
  console.error("************************************************************");
  console.error("FATAL: FIREBASE_SERVICE_ACCOUNT is missing!");
  console.error("************************************************************");
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

try {
  const serviceAccount = JSON.parse(saContent || "{}");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbURL
  });
  console.log("✅ Firebase Admin Initialized");
} catch (e) {
  console.error("FATAL: Invalid Service Account JSON:", e.message);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

const db = admin.database();

console.log("🎧 HIGH-PRIORITY FCM Relay — listening on fcm_queue...");

/* =========================================================
 * ⭐ CORE: SEND HIGH-PRIORITY FCM (wakes device from Doze)
 * ========================================================= */
async function sendHighPriorityFcm(deviceId, adminId, type = "WAKE_UP") {
  try {
    // ---- 1. Find the FCM token ----
    let token = null;

    if (adminId) {
      const snap = await db.ref(`fcmTokens/${adminId}/${deviceId}`).once("value");
      token = snap.val();
    }

    // Fallback 1: flat path
    if (!token) {
      const snap = await db.ref(`fcmTokens/${deviceId}`).once("value");
      token = snap.val();
    }

    // Fallback 2: legacy path
    if (!token) {
      const snap = await db.ref(`Users/${deviceId}/I/tk`).once("value");
      token = snap.val();
    }

    if (!token) {
      console.warn(`[SKIP] No token | device=${deviceId} admin=${adminId}`);
      return { success: false, reason: "no_token" };
    }

    // ---- 2. Build HIGH-PRIORITY DATA-ONLY message ----
    // ⭐ No `notification` field — ensures onMessageReceived() always fires
    const message = {
      token: token,

      // Data payload — always delivered, always triggers onMessageReceived
      data: {
        t: type,
        ts: Date.now().toString(),
        p: "high"
      },

      // ⭐ Android-specific — CRITICAL for Doze bypass
      android: {
        priority: "high",       // bypasses Doze battery restrictions
        ttl: 60 * 1000          // 60 sec — old wakeups useless
        // ❌ directBootOk removed — only works if manifest has directBootAware=true
      }

      // ❌ notification field removed — otherwise onMessageReceived()
      //    will NOT fire when app is in background/killed
    };

    // ---- 3. Send ----
    const response = await admin.messaging().send(message);
    console.log(`[✅ SENT] device=${deviceId} type=${type} id=${response}`);
    return { success: true, id: response };

  } catch (error) {
    console.error(`[❌ FCM ERROR] device=${deviceId}:`, error.message);

    // ---- 4. Clean up invalid tokens ----
    const invalid =
      error.code === "messaging/registration-token-not-registered" ||
      error.code === "messaging/invalid-registration-token";

    if (invalid) {
      try {
        if (adminId) await db.ref(`fcmTokens/${adminId}/${deviceId}`).remove();
        await db.ref(`fcmTokens/${deviceId}`).remove();
        console.log(`🧹 Removed invalid token for ${deviceId}`);
      } catch (e) {
        console.error("Cleanup error:", e.message);
      }
    }

    return { success: false, reason: error.message };
  }
}

/* =========================================================
 * 📡 QUEUE LISTENER — instant trigger on admin action
 * ========================================================= */
db.ref("fcm_queue").on("child_added", async (snapshot) => {
  const queueId = snapshot.key;
  const payload = snapshot.val();

  if (!payload || !payload.targetUid) {
    console.log(`[QUEUE] Invalid entry ${queueId}, removing`);
    return db.ref(`fcm_queue/${queueId}`).remove();
  }

  const targetUid = payload.targetUid;
  const requestedBy = payload.requestedBy || null;
  const type = payload.type || "WAKE_UP";

  console.log(`[QUEUE] ⚡ target=${targetUid} type=${type} by=${requestedBy}`);

  try {
    if (targetUid === "ALL") {
      await broadcastToAll(requestedBy, type);
    } else {
      await sendHighPriorityFcm(targetUid, requestedBy, type);
    }
  } catch (err) {
    console.error(`[ERROR] Task ${queueId}:`, err.message);
  } finally {
    // Always remove processed task
    db.ref(`fcm_queue/${queueId}`).remove();
  }
});

/* =========================================================
 * 📢 BROADCAST HELPER
 * ========================================================= */
async function broadcastToAll(adminId, type) {
  if (!adminId) {
    console.warn("[BROADCAST] No adminId — skipping");
    return;
  }

  const snap = await db.ref(`fcmTokens/${adminId}`).once("value");
  const tokens = snap.val() || {};
  const deviceIds = Object.keys(tokens);

  console.log(`[BROADCAST] Sending to ${deviceIds.length} devices of ${adminId}`);

  const results = await Promise.allSettled(
    deviceIds.map(id => sendHighPriorityFcm(id, adminId, type))
  );

  const ok = results.filter(r => r.status === "fulfilled" && r.value.success).length;
  console.log(`[BROADCAST] ✅ ${ok}/${deviceIds.length} delivered`);
}

/* =========================================================
 * 🌐 HEALTH CHECK
 * ========================================================= */
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>FCM Relay — Active</title></head>
      <body style="font-family:-apple-system,sans-serif;background:#0f172a;color:white;text-align:center;padding:3rem">
        <div style="display:inline-block;background:#1e293b;padding:2rem;border-radius:1rem">
          <h1 style="margin:0">🚀 FCM Relay Active</h1>
          <p style="color:#94a3b8">Mode: <b style="color:#10b981">HIGH-PRIORITY DATA-ONLY</b></p>
          <p style="color:#94a3b8">DB: <code style="color:#3b82f6">${dbURL}</code></p>
          <p style="color:#64748b;font-size:0.85rem">Listening on <code>fcm_queue</code></p>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SYSTEM] ✅ FCM Relay on port ${PORT}`);
});