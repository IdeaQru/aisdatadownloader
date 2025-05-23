const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3045;

app.use(cors());

const uri = 'mongodb://marin:123@146.190.89.97:27017/?authMechanism=DEFAULT&authSource=maritim';

// Load identity.json sekali saat server start
const identityPath = path.join(__dirname, 'identity.json');
let identityData = {};

try {
  const rawData = fs.readFileSync(identityPath, 'utf8');
  identityData = JSON.parse(rawData);
  console.log('Berhasil load identity.json');
} catch (err) {
  console.error('Gagal load identity.json:', err);
}

// Fungsi helper untuk ambil data statis dari identity.json
function getStaticFromIdentity(mmsi) {
  const mmsiStr = String(mmsi);
  return identityData[mmsiStr] || null;
}

// Serve static files Angular
app.use(express.static(path.join(__dirname, 'myapp/browser')));

app.get('/api/v2/all-data', async (req, res) => {
  const { polygon, startDate, endDate, page = 1, limit = 200 } = req.query;

  if (!polygon || !startDate || !endDate) {
    return res.status(400).json({ error: 'Missing required parameters: polygon, startDate, endDate' });
  }

  let polygonCoordinates;
  try {
    polygonCoordinates = JSON.parse(polygon).map(point => [
      parseFloat(point.lng),
      parseFloat(point.lat)
    ]);
    if (polygonCoordinates.length > 0) {
      const first = polygonCoordinates[0];
      const last = polygonCoordinates[polygonCoordinates.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        polygonCoordinates.push([first[0], first[1]]);
      }
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid polygon format' });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const pageInt = Math.max(1, parseInt(page));
  const limitInt = Math.min(500, parseInt(limit));
  const skip = (pageInt - 1) * limitInt;

  let client;
  try {
    client = await MongoClient.connect(uri);
    const db = client.db('maritim');
    const collection = db.collection('ais');

    const aggregationPipeline = [
      {
        $match: {
          loc: {
            $geoWithin: {
              $geometry: {
                type: "Polygon",
                coordinates: [polygonCoordinates]
              }
            }
          },
          created_at: { $gte: start, $lte: end },
          aistype: { $nin: [5, 24] }
        }
      },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $sort: { created_at: -1 } },
            { $skip: skip },
            { $limit: limitInt },
            {
              $lookup: {
                from: "ship",
                let: { mmsi: "$mmsi" },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $eq: ["$MMSI", "$$mmsi"]
                      }
                    }
                  },
                  {
                    $project: {
                      IMO: 1,
                      MMSI: 1,
                      NAME: 1,
                      BUILT: 1,
                      FLAG: 1,
                      FLAGNAME: 1,
                      TYPE: 1,
                      TYPENAME: 1,
                      GT: 1,
                      DWT: 1,
                      LOA: 1,
                      BEAM: 1,
                      DRAUGHT: 1,
                      CLASS: 1,
                      CLASSCODE: 1
                    }
                  }
                ],
                as: "static"
              }
            }
          ]
        }
      }
    ];

    const result = await collection.aggregate(aggregationPipeline).toArray();

    const data = result[0].data.map(item => {
      // Ambil data statis dari koleksi ship jika ada
      let staticData = {};
      if (item.static && item.static.length > 0) {
        staticData = {
          IMO: item.static[0].IMO || "-",
          MMSI: item.static[0].MMSI || "-",
          NAME: item.static[0].NAME || "-",
          BUILT: item.static[0].BUILT || "-",
          FLAG: item.static[0].FLAG || "-",
          FLAGNAME: item.static[0].FLAGNAME || "-",
          TYPE: item.static[0].TYPE || "-",
          TYPENAME: item.static[0].TYPENAME || "-",
          GT: item.static[0].GT || "-",
          DWT: item.static[0].DWT || "-",
          LOA: item.static[0].LOA || "-",
          BEAM: item.static[0].BEAM || "-",
          DRAUGHT: item.static[0].DRAUGHT || "-",
          CLASS: item.static[0].CLASS || "-",
          CLASSCODE: item.static[0].CLASSCODE || "-"
        };
      } else {
        // Jika tidak ada, fallback ke identity.json
        const fallback = getStaticFromIdentity(item.mmsi);
        if (fallback) {
          staticData = fallback;
        } else {
          // Jika tidak ada juga di identity.json, isi default "-"
          staticData = {
            IMO: "-",
            MMSI: "-",
            NAME: "-",
            BUILT: "-",
            FLAG: "-",
            FLAGNAME: "-",
            TYPE: "-",
            TYPENAME: "-",
            GT: "-",
            DWT: "-",
            LOA: "-",
            BEAM: "-",
            DRAUGHT: "-",
            CLASS: "-",
            CLASSCODE: "-"
          };
        }
      }

      return {
        mmsi: item.mmsi,
        timestamp: item.created_at,
        position: {
          latitude: item.loc.coordinates[1],
          longitude: item.loc.coordinates[0]
        },
        movement: {
          sog: item.sog,
          cog: item.cog,
          heading: item.hdg || null,
          rot: item.rot,
          navStatus: item.navstat
        },
        static: staticData
      };
    });

    res.json({
      data,
      pagination: {
        total: result[0].metadata[0]?.total || 0,
        page: pageInt,
        pageSize: limitInt,
        totalPages: Math.ceil((result[0].metadata[0]?.total || 0) / limitInt)
      }
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  } finally {
    if (client) {
      client.close();
    }
  }
});

// Wildcard route untuk SPA Angular
app.get('/demn', (req, res) => {
  res.sendFile(path.join(__dirname, 'myapp/browser', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
