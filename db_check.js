const mongoose = require('mongoose');

async function run() {
  const uri = 'mongodb+srv://overx:ankit5639@lolcluster.68fu58k.mongodb.net/?appName=lolcluster';
  const uri2 = 'mongodb+srv://overx:ankit5639@lolcluster.68fu58k.mongodb.net/lolcluster?appName=lolcluster';

  console.log('connecting with uri1', uri);
  await mongoose.connect(uri, {useNewUrlParser: true, useUnifiedTopology: true});
  const db = mongoose.connection.db;
  const dbs = await db.admin().listDatabases();
  console.log('dbs', dbs.databases.map(d => d.name));
  console.log('current db1', db.databaseName);
  const coll1 = await db.listCollections().toArray();
  console.log('collections1', coll1.map(c => c.name));
  if (coll1.find(c => c.name === 'users')) {
    console.log('users count1', await db.collection('users').countDocuments());
  }

  const conn2 = await mongoose.createConnection(uri2, {useNewUrlParser: true, useUnifiedTopology: true});
  const db2 = conn2.db;
  console.log('current db2', db2.databaseName);
  const coll2 = await db2.listCollections().toArray();
  console.log('collections2', coll2.map(c => c.name));
  if (coll2.find(c => c.name === 'users')) {
    console.log('users count2', await db2.collection('users').countDocuments());
  }

  await mongoose.disconnect();
  await conn2.close();
}

run().then(() => process.exit(0)).catch(err => {console.error(err); process.exit(1);});