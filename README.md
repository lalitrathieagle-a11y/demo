# FCM Wakeup Server

This server listens to the `fcm_queue` in Firebase Realtime Database and sends "WAKE_UP" notifications to Android devices.

## How to deploy on Render

1.  Create a new Web Service on Render.
2.  Connect your GitHub repository.
3.  Set the following **Environment Variables** in Render:
    *   `DATABASE_URL`: Your Firebase Database URL (e.g., `https://your-app.firebaseio.com`)
    *   `FIREBASE_SERVICE_ACCOUNT`: The entire content of your `service-account.json` file.
        *   To get this: Firebase Console -> Project Settings -> Service Accounts -> Generate New Private Key.
        *   Copy the JSON content and paste it as the value for this variable.

## Functionality
*   Listens to `fcm_queue`.
*   Fetches FCM token from `Users/{uid}/I/tk`.
*   Sends a high-priority data message.
*   Deletes the task from queue after completion.
