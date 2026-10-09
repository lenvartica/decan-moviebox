# Decan Movie

Decan Movie is an account-free movie, TV, and anime discovery site with a Capacitor Android app. Search, browsing, watchlists, favorites, and personal lists run in the browser and are saved in local storage. In-app movie playback and offline downloads are limited to individually reviewed, openly licensed catalog entries; other titles link to their official providers.

## Run and deploy

Deploy the project to Vercel so the JavaScript API routes in `api/` can provide TMDB data. Set `TMDB_ACCESS_TOKEN` in the Vercel project environment; the token must not be placed in browser code. Static pages can also be opened directly, but movie data requests require the deployed API route.

The project no longer includes PHP endpoints, SQL scripts, or account, sign-in, profile, and admin pages. Existing accounts or data stored in a separate Supabase project are not deleted by removing these local files. Delete remote users separately in the Supabase Dashboard if needed.

## Android app

The Android app is built from the HTML, CSS, and JavaScript frontend. It requires Node.js, Android Studio with the Android SDK (API 35), and a compatible JDK. Android 8.0 (API 26) is the minimum supported version.

1. Install dependencies with `npm install`.
2. Build the web assets and sync Capacitor with `npm run build:android`.
3. Open the project in Android Studio with `npm run android:open`, or build a debug APK with `npm run android:debug`.
4. For direct distribution, create a release signing key, configure signing locally in Android Studio/Gradle without committing credentials, then build with `npm run android:release`. The release artifact is an Android App Bundle; generate a signed APK in Android Studio if you need APK distribution.

The TMDB API endpoint defaults to the deployed Decan Movie API. To use a different endpoint, set `DECAN_TMDB_API_BASE` to an HTTPS URL ending in `/api/tmdb` before building. Do not put the TMDB access token in the app.

The approved catalog currently contains a single reviewed Blender Foundation film. Rights and playback compatibility are checked per entry, and the publisher's license statements are not a substitute for checking local law. Android offline downloads are app-private and currently support direct media files, not HLS/DASH offline packaging. Streaming reliability depends on the source host, supported codecs, network conditions, and device capabilities; no remote playback source can be guaranteed to work on every device.
