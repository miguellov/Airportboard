const express = require("express");
const cors = require("cors");
const FlightRadar24API = require("flightradarapi");

const app = express();
app.use(cors());

const frApi = new FlightRadar24API();

/* 🔥 ENDPOINT */
app.get("/flights", async (req, res) => {
    try {
        const flights = await frApi.getFlights();

        // SOLO algunos para prueba
        const clean = flights.slice(0, 10).map(f => ({
            vuelo: f.callsign,
            destino: f.destination_airport_iata,
            estado: "ON-TIME",
            gate: "",
            llegada: "10:00",
            salida: "10:30"
        }));

        res.json(clean);

    } catch (err) {
        console.error(err);
        res.status(500).json({error:"Error"});
    }
});

app.listen(3000, ()=>console.log("API corriendo en http://localhost:3000"));