require('dotenv').config();
const { MongoClient } = require("mongodb");

const uri = process.env.URI;
const client = new MongoClient(uri);
const db =  client.db('test');


const DB = {};

function connect(name){
  DB[name] = db.collection(name);
  return DB[name];  
}

client.connect().then(() => { console.log("DATABASE CONNECTED!"); }).catch((e) => { console.log(e); });

module.exports = { connect };