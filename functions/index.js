/* eslint-disable promise/no-nesting */
/* eslint-disable promise/always-return */
/* eslint-disable promise/catch-or-return */
/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const dev = false;

const fs = require('fs'); // DEBUGGING
const functions = require('firebase-functions');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const moment = require('moment');
const GeoFire = require('geofire').GeoFire;


// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: dev
    ? `http://localhost:9000`
    : `https://${process.env.GCLOUD_PROJECT}.firebaseio.com`
});

// Geofire
const geofireRef = admin.database().ref('/geofire');
const geoFire = new GeoFire(geofireRef);

// Spotify OAuth 2 setup
// TODO: Configure the `spotify.client_id` and `spotify.client_secret` Google Cloud environment variables.
const SpotifyWebApi = require('spotify-web-api-node');
const Spotify = new SpotifyWebApi({
  clientId: 'c74433d6d8864f5b8d80f2fedbd46403',
  clientSecret: '18f3206f6d584ad78d2778fe6e3cdc5e',
  redirectUri: dev
    ? 'http://localhost:5000'
    : `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com/popup.html`
});

// Scopes to request.
const OAUTH_SCOPES = [
  'user-read-email',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-top-read',
  'user-read-recently-played',
  'user-library-modify',
  'user-library-read',
  'user-follow-modify',
  'user-follow-read',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-collaborative',
  'user-read-private',
  'app-remote-control',
  'streaming'
];

/**
 * Redirects the User to the Spotify authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
exports.redirect = functions.https.onRequest((req, res) => {
  cookieParser()(req, res, () => {
    const state = req.cookies.state || crypto.randomBytes(20).toString('hex');
    console.log('Setting verification state:', state);
    res.cookie('state', state.toString(), {
      maxAge: 3600000,
      secure: true,
      httpOnly: true
    });
    const authorizeURL = Spotify.createAuthorizeURL(
      OAUTH_SCOPES,
      state.toString()
    );
    res.redirect(authorizeURL);
  });
});

/**
 * Exchanges a given Spotify auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie.
 * The Firebase custom auth token is sent back in a JSONP callback function with function name defined by the
 * 'callback' query parameter.
 */
exports.token = functions.https.onRequest((req, res) => {
  try {
    cookieParser()(req, res, () => {
      console.log('Received verification state:', req.cookies.state);
      console.log('Received state:', req.query.state);
      if (!req.cookies.state) {
        throw new Error(
          'State cookie not set or expired. Maybe you took too long to authorize. Please try again.'
        );
      } else if (req.cookies.state !== req.query.state) {
        throw new Error('State validation failed');
      }
      console.log('Received auth code:', req.query.code);
      Spotify.authorizationCodeGrant(req.query.code, (error, data) => {
        if (error) {
          throw error;
        }
        console.log('Received Access Token:', data.body['access_token']);
        Spotify.setAccessToken(data.body['access_token']);

        Spotify.getMe(async (error, userResults) => {
          if (error) {
            throw error;
          }
          console.log('Auth code exchange result received:', userResults);
          // We have a Spotify access token and the user identity now.
          const accessToken = data.body['access_token'];
          const spotifyUserID = userResults.body['id'];
          const profilePic = userResults.body['images'][0]['url'];
          const userName = userResults.body['display_name'];
          const email = userResults.body['email'];

          // Create a Firebase account and get the Custom Auth Token.
          const firebaseToken = await createFirebaseAccount(
            spotifyUserID,
            userName,
            profilePic,
            email,
            accessToken
          );
          // Serve an HTML page that signs the user in and updates the user profile.
          res.jsonp({ token: firebaseToken });
        });
      });
    });
  } catch (error) {
    return res.jsonp({ error: error.toString });
  }
  return null;
});

/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /spotifyAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
async function createFirebaseAccount(
  spotifyID,
  displayName,
  photoURL,
  email,
  accessToken
) {
  // The UID we'll assign to the user.
  const uid = `spotify:${spotifyID}`;

  // Save the access token to the Firebase Realtime Database.
  const databaseTask = admin
    .database()
    .ref(`/users/${uid}`)
    .set({ accessToken });

  // Create or update the user account.
  const userCreationTask = admin
    .auth()
    .updateUser(uid, {
      displayName: displayName,
      photoURL: photoURL,
      email: email,
      emailVerified: true
    })
    .catch(error => {
      // If user does not exists we create it.
      if (error.code === 'auth/user-not-found') {
        return admin.auth().createUser({
          uid: uid,
          displayName: displayName,
          photoURL: photoURL,
          email: email,
          emailVerified: true
        });
      }
      throw error;
    });

  // Wait for all async tasks to complete, then generate and return a custom auth token.
  await Promise.all([userCreationTask, databaseTask]);
  // Create a Firebase custom auth token.
  const token = await admin.auth().createCustomToken(uid);
  console.log('Created Custom token for UID "', uid, '" Token:', token);
  return token;
}

const checkAndSaveSong = async ({ songId }) => {
  admin
    .firestore()
    .collection('songs')
    .doc(songId)
    .get()
    .then(snapshot => {
      if (!snapshot.exists) {
        saveSong({ songId });
      } else {
        console.log(`Song ${songId} already exists`);
      }
      return;
    })
    .catch(err => {
      console.error('An error occured when trying to save song ', songId, err);
    });
};

const saveSong = async ({ songId }) => {
  const spotifyToken = admin
    .database()
    .ref('/users/spotify:21x6nn6cz3sul4xpohjcyap7y')
    .once('value')
    .then(snapshot => {
      const spotifyAccessToken = snapshot.val() && snapshot.val().accessToken;
      Spotify.setAccessToken(spotifyAccessToken);

      Spotify.getAudioAnalysisForTrack(songId, (err, data) => {
        if (err) {
          console.error(
            `An error ocurred when trying to fetch analysis for ${songId}\n${err}`
          );
        } else {
          let arr = [];
          let SectArr = [];
          let counter = 0;

          data.body.sections.forEach((element, i) => {
            SectArr.push({
              elementStart: Math.round(element.start * 1000),
              index: i
            });
          });

          data.body.segments.forEach(element => {
            if (counter < SectArr.length - 1 && element.start * 1000 > SectArr[counter].elementStart) {
              console.log("Incrementing Counter");
              counter += 1;
            }

            arr.push({
              elementStart: Math.round(element.start * 1000),
              elementLoudNess: element.loudness_start,
              section: counter
            });
          });

          admin
            .firestore()
            .collection('songs')
            .doc(songId)
            .set({
              analysis: arr
            });
        }
      });

      Spotify.getAudioFeaturesForTrack(songId, (err, data) => {
        if (err) {
          console.error(
            `An error ocurred when trying to fetch features for ${songId}\n${err}`
          );
        } else {
          admin
            .firestore()
            .collection('songs')
            .doc(songId)
            .set({
              features: JSON.parse(JSON.stringify(data.body))
            });
        }
      });
      return null;
    });
};

exports.saveSong = functions.https.onRequest((req, res) => {
  const { songId } = req.query;
  checkAndSaveSong({ songId, res });
});

const updateUsersState = async ({ token }) => {
  Spotify.setAccessToken(token);
  console.log(`Requesting current playback state from spotify`);
  Spotify.getMyCurrentPlaybackState({})
    .then(data => {
      if (data.statusCode != 204) {
        const artistsNames = data.body.item.artists
          .map(a => `${a.name},`)
          .join(' ');
        const songName = data.body.item.name;
        const albumName = data.body.item.album.name;
        const songID = data.body.item.id;
        const progress = data.body.progress_ms;
        const isPlaying = data.body.is_playing;
        const timestamp = data.body.timestamp;
        const startTime = timestamp - progress;

        if (!isPlaying) {
          admin
            .database()
            .ref(`/songs/${songID}`)
            .remove();
          geoFire.remove(songID);
        } else {
          admin
          .database()
          .ref('/token')
          .once('value')
          .then(snapshot => {
            const spotifyAccessToken =
              snapshot.val() && snapshot.val().accessToken;
            Spotify.setAccessToken(spotifyAccessToken);

            Spotify.getAudioAnalysisForTrack(songID, (err, data) => {
              if (err) {
                console.error(
                  `An error ocurred when trying to fetch analysis for ${songID}\n${err}`
                );
              } else {
                const SectArr = data.body.sections.map((element, i) => {
                  return {
                    elementStart: Math.round(element.start * 1000),
                    index: i
                  };
                });
                let counter = 0;

                const arr = data.body.segments.map(element => {
                  if (counter < SectArr.length -1 && element.start * 1000 >  SectArr[counter].elementStart) {
                    counter++;
                  }
                  return {
                    elementStart: Math.round(element.start * 1000),
                    elementLoudness: Math.abs(element.loudness_start),
                    section: counter
                  };
                });

                let metadata = {
                  albumName,
                  songName,
                  progress,
                  startTime,
                  artists: artistsNames,
                  apiID: songID,
                  beats: arr
                };

                admin
                  .database()
                  .ref(`/songs/${songID}`)
                  .update({
                    current: metadata
                  });

                // Using geofire add the song to the geofire database
                admin
                  .database()
                  .ref(`/users/${token}`)
                  .once('value', (snapshot) => {
                    const { latitude, longitude } = snapshot.val().location;
                    geoFire.set(songID, [latitude, longitude]).then(() => {
                      console.log('Saved ', songID, ' to geofire');
                    }, (err) => {
                      console.error("Error when trying to save ", songID, ' to geoFire', err);
                    })
                  })
              }
            });
          });
        }
        return;
      }
    })
    .catch(err => {
      console.log(
        `An error occured when trying to update the users state for ${token}\n${err}`
      );
    });
};

const validateUser = ({ user }) => {
  return (
    moment.unix(user.expiresAt).isAfter(moment()) &&
    user.location &&
    user.location.latitude &&
    user.location.longitude
  );
};

const injectUserInfo = ({ token }) => {
  Spotify.setAccessToken(token);
  Spotify.getMe().then((data) => {
    admin
      .database()
      .ref(`/users/${token}`)
      .update({
        user_id: data.body.id
      })
  }, (err) => {
    console.log('Error when getMe on ', token, err);
  });
};

const updateUsers = async () => {
  admin
    .database()
    .ref('users')
    .once('value', snapshot => {
      snapshot.forEach(data => {
        const { token = null } = data.val();
        if (token && validateUser({ user: data.val() })) {
          console.log('=== Updating token ===', token);
          updateUsersState({ token });
          injectUserInfo({ token });
        } else {
          console.log('Failed validation for', data.val());
        }
      });
    });
};

exports.updateUsers = functions.https.onRequest((req, res) => {
  updateUsers();
});

exports.geoFire = functions.https.onRequest((req, res) => {
  const geoQuery = geoFire.query({
    center: [43.4725216, -80.5398393],
    radius: 5,
  });

  const onKeyEnteredRegistration = geoQuery.on('key_entered', (key, location, distance) => {
    console.log('=== KEY ENTERED', key);
    admin
      .database()
      .ref(`/songs/${key}`)
      .once("value", (snapshot) => {
        console.log("value", snapshot.val());
      })
  });
})