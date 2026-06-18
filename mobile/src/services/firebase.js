import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "933c97406ad862095eade39aef8a1f5d",
  authDomain: "airport-board-ee661.firebaseapp.com",
  databaseURL: "https://airport-board-ee661-default-rtdb.firebaseio.com",
  projectId: "airport-board-ee661",
  storageBucket: "airport-board-ee661.appspot.com",
  messagingSenderId: "305273183577",
  appId: "1:305273183577:web:65863c3756c646b95eade3"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
