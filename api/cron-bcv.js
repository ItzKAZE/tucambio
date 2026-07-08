const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logNotification = require('./_logNotif');

function ensureFirebase() {
    if (getApps().length === 0) {
        const json = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT env var not set");
        initializeApp({ credential: cert(JSON.parse(json)) });
    }
}

module.exports = async function handler(req, res) {
    try {
        ensureFirebase();

        const bcvRes = await fetch('https://rates.dolarvzla.com/bcv/current.json');
        if (!bcvRes.ok) throw new Error("Failed to fetch BCV");
        
        const data = await bcvRes.json();
        if (!data || !data.current || !data.current.date) {
            return res.status(200).json({ status: "Invalid data from DolarVzla" });
        }

        const currentDateStr = data.current.date; // e.g. "2026-06-25"
        const currentUsd = data.current.usd;

        // Get today's date in Caracas timezone
        const now = new Date();
        const caracasFormatter = new Intl.DateTimeFormat('en-CA', { 
            timeZone: 'America/Caracas', 
            year: 'numeric', month: '2-digit', day: '2-digit' 
        });
        const todayCaracas = caracasFormatter.format(now);

        // Rely exclusively on Firestore transaction to determine if rate is new
        // and needs a notification.


        const db = getFirestore();
        const docRef = db.collection('system').doc('bcvStatus');
        
        // Use a transaction to safely check and update the notification status
        const notified = await db.runTransaction(async (t) => {
            const doc = await t.get(docRef);
            const historyRef = db.collection('system').doc('bcvHistory');
            const historyDoc = await t.get(historyRef); // ALL READS MUST HAPPEN BEFORE ANY WRITES
            
            let lastDateStr = null;
            if (doc.exists) {
                lastDateStr = doc.data().lastDateStr;
            }
            
            if (lastDateStr === currentDateStr) {
                return false; // Already notified for this rate
            }
            
            let historyData = { history: {} };
            if (historyDoc.exists) {
                historyData = historyDoc.data();
                if (!historyData.history) historyData.history = {};
            }

            // --- NOW WE PERFORM WRITES ---
            
            // Set the new rate date
            t.set(docRef, {
                lastDateStr: currentDateStr,
                lastUsd: currentUsd,
                updatedAt: FieldValue.serverTimestamp()
            });

            // Formatear la fecha de la API (YYYY-MM-DD) a formato DD/MM/YYYY para la app
            const parts = currentDateStr.split('-');
            if (parts.length === 3) {
                const dateKey = `${parts[2]}/${parts[1]}/${parts[0]}`; // DD/MM/YYYY
                historyData.history[dateKey] = currentUsd.toFixed(4);
                t.set(historyRef, historyData, { merge: true });
            }

            return true; // We should notify
        });

        if (notified) {
            const title = "¡Actualización del BCV! 🏛️";
            const body = "Ya tenemos la nueva tasa del BCV para mañana. ¡Ingresa para verla! 💰";

            await getMessaging().send({
                topic: 'bcv_updates',
                notification: { title, body },
                android: { 
                    priority: 'high',
                    notification: {
                        icon: 'ic_stat_name',
                        color: '#000000'
                    }
                }
            });
            await logNotification('bcv_updates', title, body);

            return res.status(200).json({ status: "Notification Sent", bcv: currentUsd, date: currentDateStr });
        }

        return res.status(200).json({ status: "Already notified today", bcv: currentUsd, date: currentDateStr });

    } catch (error) {
        console.error("Cron BCV Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
