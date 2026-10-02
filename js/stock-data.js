// ============================================================
// Stock – accès Firestore (CRUD uniquement, aucune logique d'affichage)
// ============================================================

import { db, auth } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  runTransaction,
  writeBatch,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const COLLECTIONS = {
  familles: "stk-familles",
  articles: "stk-articles",
  mouvements: "stk-mouvements",
  beneficiaires: "stk-beneficiaires"
};

const arrondir = (n) => Math.round(n * 100) / 100;
const avecId = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// ---------- Écoutes temps réel ----------

export function ecouterFamilles(cb, onErreur) {
  return onSnapshot(collection(db, COLLECTIONS.familles), (s) => cb(avecId(s)), onErreur);
}

export function ecouterArticles(cb, onErreur) {
  return onSnapshot(collection(db, COLLECTIONS.articles), (s) => cb(avecId(s)), onErreur);
}

export function ecouterBeneficiaires(cb, onErreur) {
  return onSnapshot(collection(db, COLLECTIONS.beneficiaires), (s) => cb(avecId(s)), onErreur);
}

// Nécessite un index composite : partie (croissant) + date (décroissant).
export function ecouterMouvements(partie, debut, fin, cb, onErreur) {
  const q = query(
    collection(db, COLLECTIONS.mouvements),
    where("partie", "==", partie),
    where("date", ">=", Timestamp.fromDate(debut)),
    where("date", "<=", Timestamp.fromDate(fin)),
    orderBy("date", "desc")
  );
  return onSnapshot(q, (s) => cb(avecId(s)), onErreur);
}

// ---------- Familles ----------

export async function ajouterFamille(partie, nom) {
  const ref = doc(collection(db, COLLECTIONS.familles));
  await setDoc(ref, { partie, nom, creeLe: serverTimestamp() });
  return ref.id;
}

export function renommerFamille(id, nom) {
  return updateDoc(doc(db, COLLECTIONS.familles, id), { nom });
}

export function supprimerFamille(id) {
  return deleteDoc(doc(db, COLLECTIONS.familles, id));
}

// ---------- Bénéficiaires (agents / services) ----------

export async function ajouterBeneficiaire(type, libelle) {
  const ref = doc(collection(db, COLLECTIONS.beneficiaires));
  await setDoc(ref, { type, libelle, creeLe: serverTimestamp() });
  return ref.id;
}

export function supprimerBeneficiaire(id) {
  return deleteDoc(doc(db, COLLECTIONS.beneficiaires, id));
}

// ---------- Articles ----------

// Champs copiés dans chaque mouvement pour que l'historique reste lisible
// même si l'article est renommé ou archivé plus tard.
function ligneMouvement(article, type, quantite, stockApres) {
  return {
    articleId: article.id,
    partie: article.partie,
    reference: article.reference,
    designation: article.designation,
    familleId: article.familleId,
    unite: article.unite,
    type,
    quantite,
    stockApres,
    creeLe: serverTimestamp(),
    creePar: auth.currentUser?.email || ""
  };
}

export async function ajouterArticle(champs, stockInitial = 0) {
  const batch = writeBatch(db);
  const ref = doc(collection(db, COLLECTIONS.articles));
  const stock = arrondir(stockInitial);

  batch.set(ref, {
    ...champs,
    stock,
    actif: true,
    creeLe: serverTimestamp(),
    majLe: serverTimestamp()
  });

  if (stock > 0) {
    batch.set(doc(collection(db, COLLECTIONS.mouvements)), {
      ...ligneMouvement({ id: ref.id, ...champs }, "entree", stock, stock),
      beneficiaireId: "",
      beneficiaireType: "",
      beneficiaireLibelle: "",
      commentaire: "Stock initial",
      date: Timestamp.now()
    });
  }

  await batch.commit();
  return ref.id;
}

export function modifierArticle(id, champs) {
  return updateDoc(doc(db, COLLECTIONS.articles, id), { ...champs, majLe: serverTimestamp() });
}

export function archiverArticle(id, actif) {
  return updateDoc(doc(db, COLLECTIONS.articles, id), { actif, majLe: serverTimestamp() });
}

// ---------- Mouvements ----------

// Transaction : le stock de l'article et le mouvement sont écrits ensemble,
// et une sortie ne peut pas faire passer le stock sous zéro.
export async function enregistrerMouvement({ articleId, type, quantite, date, beneficiaire, commentaire }) {
  const refArticle = doc(db, COLLECTIONS.articles, articleId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(refArticle);
    if (!snap.exists()) {
      throw new Error("Cet article n'existe plus.");
    }

    const article = { id: snap.id, ...snap.data() };
    const actuel = article.stock || 0;
    const q = arrondir(quantite);
    const nouveau = arrondir(type === "entree" ? actuel + q : actuel - q);

    if (nouveau < 0) {
      throw new Error(`Stock insuffisant : il reste ${actuel} ${article.unite} de ${article.designation}.`);
    }

    tx.update(refArticle, { stock: nouveau, majLe: serverTimestamp() });
    tx.set(doc(collection(db, COLLECTIONS.mouvements)), {
      ...ligneMouvement(article, type, q, nouveau),
      beneficiaireId: beneficiaire?.id || "",
      beneficiaireType: beneficiaire?.type || "",
      beneficiaireLibelle: beneficiaire?.libelle || "",
      commentaire: commentaire || "",
      date: Timestamp.fromDate(date)
    });
  });
}

// Supprime un mouvement saisi par erreur et corrige le stock en conséquence.
export async function annulerMouvement(mouvementId) {
  const refMvt = doc(db, COLLECTIONS.mouvements, mouvementId);

  await runTransaction(db, async (tx) => {
    const sm = await tx.get(refMvt);
    if (!sm.exists()) {
      throw new Error("Ce mouvement a déjà été supprimé.");
    }

    const m = sm.data();
    const refArticle = doc(db, COLLECTIONS.articles, m.articleId);
    const sa = await tx.get(refArticle);

    if (sa.exists()) {
      const actuel = sa.data().stock || 0;
      const corrige = arrondir(m.type === "entree" ? actuel - m.quantite : actuel + m.quantite);
      if (corrige < 0) {
        throw new Error("Impossible d'annuler cette entrée : une partie de ce stock a déjà été sortie.");
      }
      tx.update(refArticle, { stock: corrige, majLe: serverTimestamp() });
    }

    tx.delete(refMvt);
  });
}
