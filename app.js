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
  const { polygon, startDate, endDate, page = 1, limit = 500 } = req.query;

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
// app.get('/api/v2/realtime', async (req, res) => {
//   const { interval = 5000, limit = 1000 } = req.query;

//   // Set headers untuk SSE
//   res.writeHead(200, {
//     'Content-Type': 'text/event-stream',
//     'Cache-Control': 'no-cache',
//     'Connection': 'keep-alive',
//     'Access-Control-Allow-Origin': '*',
//     'Access-Control-Allow-Headers': 'Cache-Control'
//   });

//   // Fungsi untuk mendapatkan data 15 menit terakhir
//   const getLast15MinutesData = async () => {
//     try {
//       const client = await MongoClient.connect(uri);
//       const db = client.db('maritim');
//       const aisCollection = db.collection('ais');
      
//       // Waktu 15 menit yang lalu sampai sekarang
//       const now = new Date();
//       const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
      
//       console.log(`Fetching data from ${fifteenMinutesAgo} to ${now}`);
      
//       const aggregationPipeline = [
//         {
//           $match: {
//             created_at: { 
//               $gte: fifteenMinutesAgo,
//               $lte: now 
//             },
//             aistype: { $nin: [5, 24] } // Exclude base stations dan aids to navigation
//           }
//         },
//         {
//           $sort: { created_at: -1 }
//         },
//         {
//           $group: {
//             _id: "$mmsi",
//             latestData: { $first: "$$ROOT" }
//           }
//         },
//         {
//           $replaceRoot: { newRoot: "$latestData" }
//         },
//         {
//           $limit: parseInt(limit)
//         },
//         {
//           $lookup: {
//             from: "ship",
//             let: { mmsi: "$mmsi" },
//             pipeline: [
//               {
//                 $match: {
//                   $expr: { $eq: ["$MMSI", "$$mmsi"] }
//                 }
//               },
//               {
//                 $project: {
//                   IMO: 1, MMSI: 1, NAME: 1, BUILT: 1,
//                   FLAG: 1, FLAGNAME: 1, TYPE: 1, TYPENAME: 1,
//                   GT: 1, DWT: 1, LOA: 1, BEAM: 1,
//                   DRAUGHT: 1, CLASS: 1, CLASSCODE: 1
//                 }
//               }
//             ],
//             as: "static"
//           }
//         },
//         {
//           $lookup: {
//             from: "ships",
//             let: { mmsi: "$mmsi" },
//             pipeline: [
//               {
//                 $match: {
//                   $expr: { $eq: ["$mmsi", "$$mmsi"] }
//                 }
//               }
//             ],
//             as: "shipsData"
//           }
//         }
//       ];

//       const result = await aisCollection.aggregate(aggregationPipeline).toArray();
      
//       const processedData = result.map(item => {
//         let staticData = getStaticData(item);
        
//         // Hitung berapa menit yang lalu data ini diterima
//         const dataAge = Math.floor((now - new Date(item.created_at)) / 60000);
        
//         return {
//           mmsi: item.mmsi,
//           timestamp: item.created_at,
//           dataAgeMinutes: dataAge,
//           position: {
//             latitude: item.loc ? item.loc.coordinates[1] : null,
//             longitude: item.loc ? item.loc.coordinates[0] : null
//           },
//           movement: {
//             sog: item.sog || 0,
//             cog: item.cog || 0,
//             heading: item.hdg || null,
//             rot: item.rot || 0,
//             navStatus: item.navstat || 0
//           },
//           static: staticData,
//           lastUpdate: new Date().toISOString()
//         };
//       });

//       await client.close();
//       return processedData;
      
//     } catch (error) {
//       console.error('Error fetching last 15 minutes data:', error);
//       return [];
//     }
//   };

//   // Fungsi untuk mendapatkan data static dengan fallback
//   const getStaticData = (item) => {
//     // Priority 1: Data dari collection 'ship'
//     if (item.static && item.static.length > 0) {
//       const ship = item.static[0];
//       return {
//         IMO: ship.IMO || "-",
//         MMSI: ship.MMSI || item.mmsi,
//         NAME: ship.NAME || "-",
//         BUILT: ship.BUILT || "-",
//         FLAG: ship.FLAG || "-",
//         FLAGNAME: ship.FLAGNAME || "-",
//         TYPE: ship.TYPE || "-",
//         TYPENAME: ship.TYPENAME || "-",
//         GT: ship.GT || "-",
//         DWT: ship.DWT || "-",
//         LOA: ship.LOA || "-",
//         BEAM: ship.BEAM || "-",
//         DRAUGHT: ship.DRAUGHT || "-",
//         CLASS: ship.CLASS || "-",
//         CLASSCODE: ship.CLASSCODE || "-"
//       };
//     }
    
//     // Priority 2: Data dari collection 'ships'
//     if (item.shipsData && item.shipsData.length > 0) {
//       const ship = item.shipsData[0];
//       return {
//         IMO: ship.imo || "-",
//         MMSI: ship.mmsi || item.mmsi,
//         NAME: ship.name || "-",
//         BUILT: ship.built || "-",
//         FLAG: ship.flag || "-",
//         FLAGNAME: ship.flagname || "-",
//         TYPE: ship.type || "-",
//         TYPENAME: ship.typename || "-",
//         GT: ship.gt || "-",
//         DWT: ship.dwt || "-",
//         LOA: ship.loa || "-",
//         BEAM: ship.beam || "-",
//         DRAUGHT: ship.draught || "-",
//         CLASS: ship.class || "-",
//         CLASSCODE: ship.classcode || "-"
//       };
//     }
    
//     // Priority 3: Fallback ke identity.json
//     const fallback = getStaticFromIdentity(item.mmsi);
//     if (fallback) {
//       return fallback;
//     }
    
//     // Priority 4: Default values
//     return {
//       IMO: "-", MMSI: item.mmsi, NAME: "-", BUILT: "-",
//       FLAG: "-", FLAGNAME: "-", TYPE: "-", TYPENAME: "-",
//       GT: "-", DWT: "-", LOA: "-", BEAM: "-",
//       DRAUGHT: "-", CLASS: "-", CLASSCODE: "-"
//     };
//   };

//   try {
//     // Kirim data awal
//     const initialData = await getLast15MinutesData();
//     res.write(`data: ${JSON.stringify({
//       type: 'initial',
//       data: initialData,
//       count: initialData.length,
//       timestamp: new Date().toISOString(),
//       timeRange: '15 minutes',
//       message: `Found ${initialData.length} vessels active in last 15 minutes`
//     })}\n\n`);

//     // Set interval untuk streaming otomatis
//     const streamInterval = setInterval(async () => {
//       const data = await getLast15MinutesData();
//       res.write(`data: ${JSON.stringify({
//         type: 'update',
//         data: data,
//         count: data.length,
//         timestamp: new Date().toISOString(),
//         timeRange: '15 minutes',
//         message: `Live update: ${data.length} vessels in last 15 minutes`
//       })}\n\n`);
//     }, parseInt(interval));

//     // Handle client disconnect
//     req.on('close', () => {
//       clearInterval(streamInterval);
//       console.log('Client disconnected from 15-minute realtime stream');
//     });

//     req.on('error', (err) => {
//       console.error('Stream error:', err);
//       clearInterval(streamInterval);
//     });

//   } catch (error) {
//     console.error('Error starting 15-minute stream:', error);
//     res.write(`data: ${JSON.stringify({
//       type: 'error',
//       message: 'Failed to start 15-minute stream',
//       error: error.message
//     })}\n\n`);
//   }
// });

app.get('/api/v2/realtime', async (req, res) => {
  const { 
    interval = 60000, 
    limit = 100,
    page = 1,
    totalLimit = 1000 
  } = req.query;

  // Set headers untuk SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Fungsi untuk mendapatkan data 15 menit terakhir (berdasarkan kode asli Anda)
  const getLast15MinutesData = async (pageNum = 1) => {
    try {
      const client = await MongoClient.connect(uri);
      const db = client.db('maritim');
      const aisCollection = db.collection('ais');
      
      // Waktu 15 menit yang lalu sampai sekarang
      const now = new Date();
      const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
      
      console.log(`Fetching data from ${fifteenMinutesAgo} to ${now}`);
      
      const pageInt = Math.max(1, parseInt(pageNum));
      const limitInt = Math.min(parseInt(limit), 500);
      const skip = (pageInt - 1) * limitInt;
      
      const aggregationPipeline = [
        {
          $match: {
            created_at: { 
              $gte: fifteenMinutesAgo,
              $lte: now 
            },
            aistype: { $nin: [5, 24] } // Exclude base stations dan aids to navigation
          }
        },
        {
          $sort: { created_at: -1 }
        },
        {
          $group: {
            _id: "$mmsi",
            latestData: { $first: "$$ROOT" }
          }
        },
        {
          $replaceRoot: { newRoot: "$latestData" }
        },
        {
          $facet: {
            metadata: [{ $count: "total" }],
            data: [
              { $skip: skip },
              { $limit: limitInt },
              {
                $lookup: {
                  from: "ship",
                  let: { mmsi: "$mmsi" },
                  pipeline: [
                    {
                      $match: {
                        $expr: { $eq: ["$MMSI", "$$mmsi"] }
                      }
                    },
                    {
                      $project: {
                        IMO: 1, MMSI: 1, NAME: 1, BUILT: 1,
                        FLAG: 1, FLAGNAME: 1, TYPE: 1, TYPENAME: 1,
                        GT: 1, DWT: 1, LOA: 1, BEAM: 1,
                        DRAUGHT: 1, CLASS: 1, CLASSCODE: 1
                      }
                    }
                  ],
                  as: "static"
                }
              },
              {
                $lookup: {
                  from: "ships",
                  let: { mmsi: "$mmsi" },
                  pipeline: [
                    {
                      $match: {
                        $expr: { $eq: ["$mmsi", "$$mmsi"] }
                      }
                    }
                  ],
                  as: "shipsData"
                }
              }
            ]
          }
        }
      ];

      const result = await aisCollection.aggregate(aggregationPipeline).toArray();
      const totalCount = result[0].metadata[0]?.total || 0;
      const vessels = result[0].data || [];
      
      const processedData = vessels.map(item => {
        let staticData = getStaticData(item);
        
        // Hitung berapa menit yang lalu data ini diterima
        const dataAge = Math.floor((now - new Date(item.created_at)) / 60000);
        
        // Klasifikasi objek berdasarkan message type
        const objectClassification = getObjectClassification(item.aistype, item.aistype);
        
        return {
          // Struktur asli Anda
          mmsi: item.mmsi,
          timestamp: item.created_at,
          dataAgeMinutes: dataAge,
          position: {
            latitude: item.loc ? item.loc.coordinates[1] : null,
            longitude: item.loc ? item.loc.coordinates[0] : null
          },
          movement: {
            sog: item.sog || 0,
            cog: item.cog || 0,
            heading: item.hdg || null,
            rot: item.rot || 0,
            navStatus: item.navstat || 0
          },
          static: staticData,
          lastUpdate: new Date().toISOString(),
          
          // Tambahan klasifikasi objek
          objectType: objectClassification.type,
          objectCategory: objectClassification.category,
          objectDescription: objectClassification.description,
          messageType: item.msgtype,
          isVessel: objectClassification.isVessel,
          iconType: objectClassification.iconType,
          
          // Struktur mirip CombinedAisData untuk konsistensi
          MMSI: item.mmsi,
          coordinates: {
            type: "Point",
            coordinates: item.loc ? [item.loc.coordinates[0], item.loc.coordinates[1]] : [0, 0]
          },
          ShipName: staticData.NAME || null,
          ShipType: staticData.TYPE || null,
          SpeedOverGround: item.sog || 0,
          CourseOverGround: item.cog || 0,
          Heading: item.hdg || 0,
          Timestamp: item.created_at.toISOString(),
          NavigationStatus: getNavigationStatusDescription(item.navstat),
          navstatDesk: getNavigationStatusDescription(item.navstat),
          msgDynamicDesk: getMessageTypeDescription(item.msgtype),
          vesseltypeDesk: getVesselTypeDescription(staticData.TYPE)
        };
      });

      await client.close();
      
      return {
        data: processedData,
        pagination: {
          total: totalCount,
          page: pageInt,
          limit: limitInt,
          totalPages: Math.ceil(totalCount / limitInt),
          hasNext: pageInt < Math.ceil(totalCount / limitInt),
          hasPrev: pageInt > 1
        }
      };
      
    } catch (error) {
      console.error('Error fetching last 15 minutes data:', error);
      return { data: [], pagination: null };
    }
  };

  // Fungsi untuk mendapatkan data static dengan fallback (sama seperti kode asli)
  const getStaticData = (item) => {
    // Priority 1: Data dari collection 'ship'
    if (item.static && item.static.length > 0) {
      const ship = item.static[0];
      return {
        IMO: ship.IMO || "-",
        MMSI: ship.MMSI || item.mmsi,
        NAME: ship.NAME || "-",
        BUILT: ship.BUILT || "-",
        FLAG: ship.FLAG || "-",
        FLAGNAME: ship.FLAGNAME || "-",
        TYPE: ship.TYPE || "-",
        TYPENAME: ship.TYPENAME || "-",
        GT: ship.GT || "-",
        DWT: ship.DWT || "-",
        LOA: ship.LOA || "-",
        BEAM: ship.BEAM || "-",
        DRAUGHT: ship.DRAUGHT || "-",
        CLASS: ship.CLASS || "-",
        CLASSCODE: ship.CLASSCODE || "-"
      };
    }
    
    // Priority 2: Data dari collection 'ships'
    if (item.shipsData && item.shipsData.length > 0) {
      const ship = item.shipsData[0];
      return {
        IMO: ship.imo || "-",
        MMSI: ship.mmsi || item.mmsi,
        NAME: ship.name || "-",
        BUILT: ship.built || "-",
        FLAG: ship.flag || "-",
        FLAGNAME: ship.flagname || "-",
        TYPE: ship.type || "-",
        TYPENAME: ship.typename || "-",
        GT: ship.gt || "-",
        DWT: ship.dwt || "-",
        LOA: ship.loa || "-",
        BEAM: ship.beam || "-",
        DRAUGHT: ship.draught || "-",
        CLASS: ship.class || "-",
        CLASSCODE: ship.classcode || "-"
      };
    }
    
    // Priority 3: Fallback ke identity.json
    const fallback = getStaticFromIdentity(item.mmsi);
    if (fallback) {
      return fallback;
    }
    
    // Priority 4: Default values
    return {
      IMO: "-", MMSI: item.mmsi, NAME: "-", BUILT: "-",
      FLAG: "-", FLAGNAME: "-", TYPE: "-", TYPENAME: "-",
      GT: "-", DWT: "-", LOA: "-", BEAM: "-",
      DRAUGHT: "-", CLASS: "-", CLASSCODE: "-"
    };
  };

  // Fungsi klasifikasi objek berdasarkan message type
  const getObjectClassification = (msgtype, aistype) => {
    const classifications = {
      // Kapal (Vessels) - Message types 1, 2, 3, 18
      1: {
        type: "VESSEL",
        category: "SHIP",
        description: "Position Report Class A",
        isVessel: true,
        iconType: "ship"
      },
      2: {
        type: "VESSEL",
        category: "SHIP", 
        description: "Position Report Class A (Assigned Schedule)",
        isVessel: true,
        iconType: "ship"
      },
      3: {
        type: "VESSEL",
        category: "SHIP",
        description: "Position Report Class A (Response to Interrogation)",
        isVessel: true,
        iconType: "ship"
      },
      18: {
        type: "VESSEL",
        category: "SHIP",
        description: "Standard Class B Position Report",
        isVessel: true,
        iconType: "ship"
      },
      
      // VTS (Vessel Traffic Service) - Message type 4
      4: {
        type: "VTS",
        category: "BASE_STATION",
        description: "Base Station Report",
        isVessel: false,
        iconType: "tower"
      },
      
      // Buoy (Aid to Navigation) - Message type 21
      21: {
        type: "BUOY",
        category: "AID_TO_NAVIGATION",
        description: "Aid-to-Navigation Report",
        isVessel: false,
        iconType: "buoy"
      },
      
      // MOB (Man Overboard) - Message type 14
      14: {
        type: "MOB",
        category: "SEARCH_RESCUE",
        description: "Safety-Related Broadcast Message / MOB",
        isVessel: false,
        iconType: "emergency"
      },
      
      // Aircraft - Message type 9
      9: {
        type: "AIRCRAFT",
        category: "AIRCRAFT",
        description: "Standard SAR Aircraft Position Report",
        isVessel: false,
        iconType: "aircraft"
      }
    };
    
    const classification = classifications[msgtype];
    
    if (classification) {
      return classification;
    }
    
    // Default untuk objek tidak dikenal
    return {
      type: "UNKNOWN",
      category: "UNCLASSIFIED",
      description: "Unknown Object Type",
      isVessel: false,
      iconType: "unknown"
    };
  };

  // Helper functions
  const getNavigationStatusDescription = (navstat) => {
    const statuses = {
      0: "Under way using engine", 1: "At anchor", 2: "Not under command",
      3: "Restricted manoeuvrability", 4: "Constrained by her draught",
      5: "Moored", 6: "Aground", 7: "Engaged in fishing", 8: "Under way sailing",
      15: "Undefined"
    };
    return statuses[navstat] || "Unknown";
  };

  const getMessageTypeDescription = (msgtype) => {
    const types = {
      1: "Position Report Class A", 2: "Position Report Class A (Assigned)",
      3: "Position Report Class A (Response)", 4: "Base Station Report",
      9: "Standard SAR Aircraft Position Report", 14: "Safety-Related Broadcast Message",
      18: "Standard Class B Position Report", 21: "Aid-to-Navigation Report"
    };
    return types[msgtype] || "Unknown Message Type";
  };

  const getVesselTypeDescription = (vesselType) => {
    const types = {
      30: "Fishing", 31: "Towing", 32: "Towing: length exceeds 200m",
      33: "Dredging or underwater ops", 34: "Diving ops", 35: "Military ops",
      36: "Sailing", 37: "Pleasure Craft", 40: "High speed craft (HSC)",
      50: "Pilot Vessel", 51: "Search and Rescue vessel", 52: "Tug",
      53: "Port Tender", 54: "Anti-pollution equipment", 55: "Law Enforcement",
      58: "Medical Transport", 60: "Passenger", 70: "Cargo", 80: "Tanker", 90: "Other Type"
    };
    return types[vesselType] || "Unknown Vessel Type";
  };

  // Fungsi untuk mendapatkan statistik objek
  const getObjectStatistics = (data) => {
    const stats = {
      total: data.length,
      vessels: 0,
      buoys: 0,
      vts: 0,
      mob: 0,
      aircraft: 0,
      unknown: 0,
      byMessageType: {}
    };
    
    data.forEach(item => {
      switch(item.objectType) {
        case 'VESSEL': stats.vessels++; break;
        case 'BUOY': stats.buoys++; break;
        case 'VTS': stats.vts++; break;
        case 'MOB': stats.mob++; break;
        case 'AIRCRAFT': stats.aircraft++; break;
        default: stats.unknown++;
      }
      
      const msgType = item.messageType;
      if (msgType) {
        stats.byMessageType[msgType] = (stats.byMessageType[msgType] || 0) + 1;
      }
    });
    
    return stats;
  };

  try {
    // Kirim data awal (halaman 1)
    const initialResult = await getLast15MinutesData(1);
    const stats = getObjectStatistics(initialResult.data);
    
    res.write(`data: ${JSON.stringify({
      type: 'initial',
      data: initialResult.data,
      pagination: initialResult.pagination,
      statistics: stats,
      count: initialResult.data.length,
      timestamp: new Date().toISOString(),
      timeRange: '15 minutes',
      message: `Page 1: ${initialResult.data.length} objects loaded (${stats.vessels} vessels, ${stats.buoys} buoys, ${stats.vts} VTS, ${stats.mob} MOB, ${stats.aircraft} aircraft)`
    })}\n\n`);

    // Streaming dengan pagination
    let currentPage = 1;
    const streamInterval = setInterval(async () => {
      const result = await getLast15MinutesData(currentPage);
      const stats = getObjectStatistics(result.data);
      
      res.write(`data: ${JSON.stringify({
        type: 'update',
        data: result.data,
        pagination: result.pagination,
        statistics: stats,
        count: result.data.length,
        timestamp: new Date().toISOString(),
        timeRange: '15 minutes',
        message: `Page ${currentPage}: ${result.data.length} objects updated (${stats.vessels} vessels, ${stats.buoys} buoys, ${stats.vts} VTS, ${stats.mob} MOB, ${stats.aircraft} aircraft)`
      })}\n\n`);
      
      // Auto-increment page atau reset ke 1
      if (result.pagination && result.pagination.hasNext) {
        currentPage++;
      } else {
        currentPage = 1; // Reset ke halaman pertama
      }
    }, parseInt(interval));

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(streamInterval);
      console.log('Client disconnected from paginated stream');
    });

    req.on('error', (err) => {
      console.error('Stream error:', err);
      clearInterval(streamInterval);
    });

  } catch (error) {
    console.error('Error starting paginated stream:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: 'Failed to start paginated stream',
      error: error.message
    })}\n\n`);
  }
});


// Wildcard route untuk SPA Angular
app.get('/demn', (req, res) => {
  res.sendFile(path.join(__dirname, 'myapp/browser', 'index.html'));
});
app.get('/api/v2/realtime/guidance', (req, res) => {
  res.sendFile(path.join(__dirname, 'myapp/browser', 'guidance.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
