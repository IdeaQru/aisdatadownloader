const express = require('express');
const cors = require('cors');
const MongoClient = require('mongodb').MongoClient;
const app = express();
const port = 3045;
const path = require('path');

app.use(cors());

const uri = 'mongodb://marin:123@146.190.89.97:27017/?authMechanism=DEFAULT&authSource=maritim';

// Serve static files from Angular build
app.use(express.static(path.join(__dirname, 'myapp/browser')));

// Route API harus sebelum wildcard!
app.get('/api/data', async (req, res) => {
  const { polygon, startDate, endDate } = req.query;
  try {
    const polygonArray = JSON.parse(polygon).map(point => ({
      lat: parseFloat(point.lat),
      lng: parseFloat(point.lng)
    }));
    for (const point of polygonArray) {
      if (isNaN(point.lat) || isNaN(point.lng)) {
        return res.status(400).send('Invalid coordinates. All points must be numeric.');
      }
    }
    const dateFilter = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
    const client = await MongoClient.connect(uri);
    const db = client.db('maritim');
    const collection = db.collection('ais');
    const data = await collection.aggregate([
      {
        $match: {
          loc: {
            $geoWithin: {
              $polygon: polygonArray.map(coord => [coord.lng, coord.lat])
            }
          },
          created_at: dateFilter,
        }
      }
    ]).toArray();
    res.json(data);
    client.close();
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).send('Error fetching data');
  }
});
// Route untuk mendapatkan semua data tanpa filter polygon
app.get('/api/all-data', async (req, res) => {
  const { page = 1, limit = 200 } = req.query; // Default 1000 data per halaman
  const pageInt = parseInt(page);
  const limitInt = parseInt(limit);

  try {
    const client = await MongoClient.connect(uri);
    const db = client.db('maritim');
    const collection = db.collection('ais');

    // Hitung total semua dokumen
    const total = await collection.estimatedDocumentCount();

    // Ambil data dengan paginasi
    const data = await collection.find()
      .skip((pageInt - 1) * limitInt)
      .limit(limitInt)
      .toArray();

    res.json({
      data,
      total,
      page: pageInt,
      totalPages: Math.ceil(total / limitInt)
    });

    client.close();
  } catch (error) {
    console.error('Error fetching all data:', error);
    res.status(500).send('Error fetching all data');
  }
});

// Wildcard route untuk SPA Angular (Express 5.x style)
app.get('/demn', (req, res) => {
  res.sendFile(path.join(__dirname, 'myapp/browser', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
