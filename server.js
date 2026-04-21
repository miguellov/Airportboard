
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());

const API_KEY = "2d8e978a7b7c03602caaba887c89cfa9";

// 🔥 BASE LOCAL (NUNCA FALLA)
const vuelosBase = [
    { vuelo: "WS2507", destino: "YYZ", llegada: "10:00", salida: "10:30", estado: "ON TIME" },
    { vuelo: "WS123", destino: "YYC", llegada: "11:00", salida: "11:30", estado: "BOARDING" },
    { vuelo: "B6627", destino: "JFK", llegada: "12:00", salida: "12:30", estado: "DELAYED" }
];

// 🎯 FORMATO HORA
function hora(fecha){
    if(!fecha) return "--:--";
    return new Date(fecha).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

app.get("/flights", async (req, res) => {

    let resultado = [];

    try {
        const response = await axios.get(
            `https://api.aviationstack.com/v1/flights?access_key=${API_KEY}&limit=20`
        );

        const data = response.data?.data || [];

        const vuelosAPI = data
        .filter(f => f.flight && (f.arrival || f.departure))
        .map(f => ({
            vuelo: f.flight?.iata || f.flight?.number || "N/A",
            destino: f.arrival?.iata || f.departure?.iata || "N/A",
            llegada: hora(f.arrival?.scheduled),
            salida: hora(f.departure?.scheduled),
            estado: (f.flight_status || "UNKNOWN").toUpperCase()
        }));

        if(vuelosAPI.length > 0){
            resultado = [...vuelosAPI.slice(0,10), ...vuelosBase];
        }

    } catch (err) {
        console.log("ERROR API:", err.message);
    }

    if(resultado.length === 0){
        resultado = vuelosBase;
    }

    res.json(resultado);
});

app.listen(4000, () => {
    console.log("🔥 http://localhost:4000/flights");
});
```
