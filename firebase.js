// Initialisation Firebase pour l'app stock.
// Colle ici la même configuration que dans ton app principale (même projet Firebase)
// et garde la même version du SDK partout dans le projet.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAQTozo6vM1uIQfA7742DuxiPJTOuLpTHE",
  authDomain: "gestion-stock-45da7.firebaseapp.com",
  projectId: "gestion-stock-45da7",
  storageBucket: "gestion-stock-45da7.firebasestorage.app",
  messagingSenderId: "214217110327",
  appId: "1:214217110327:web:390de30dd59b25875a20b2"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
