require("dotenv").config();

const fs = require("fs");

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();

const { Api, TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { password: passwordUtils } = require("telegram");
const { NewMessage } = require("telegram/events/index.js");

const delay = (s) => new Promise(r => setTimeout(r, 1000 * s));

const ID_SERVER = process.env.ID_SERVER;
const DB = require("./connectDB.js");

const usersAppDB = DB.connect("pw_app");
const serversDB = DB.connect("pw_servers");
const channelsDB = DB.connect("pw_channels");

let SERVER = "";

app.use(cors({ methods: ["GET", "POST"] }));
app.use(express.json());

const CLIENTS = {}; 
const USERS = {}; 
const HASH_TABLE = {}; 




// Auth Telegeam
app.post('/auth/phone', async (req, res) => {
  const { id, phone, api_id, api_hash } = req.body;
  HASH_TABLE[id] = hashCode();
  const _hashCode = HASH_TABLE[id];
  CLIENTS[_hashCode] = { phone };
  USERS[_hashCode] = { id };


  if(api_id){
    CLIENTS[_hashCode].api_id = +api_id;
    CLIENTS[_hashCode].api_hash = api_hash;
  }else{
    CLIENTS[_hashCode].api_id = +SERVER.API_ID;
    CLIENTS[_hashCode].api_hash = SERVER.API_HASH;
  }

  console.log( CLIENTS[_hashCode].api_id, CLIENTS[_hashCode].api_hash ); 
  
  try {

    CLIENTS[_hashCode].client = new TelegramClient( new StringSession(""), CLIENTS[_hashCode].api_id, CLIENTS[_hashCode].api_hash,  { connectionRetries: 5, useWSS: true });
    await CLIENTS[_hashCode].client.connect();

    CLIENTS[_hashCode].resultSendCode = await CLIENTS[_hashCode].client.invoke(
      new Api.auth.SendCode({
        phoneNumber: CLIENTS[_hashCode].phone,
        apiId: CLIENTS[_hashCode].api_id,
        apiHash: CLIENTS[_hashCode].api_hash,
        settings: new Api.CodeSettings({
          allowFlashcall: true,
          currentNumber: true,
          allowAppHash: true,
          allowMissedCall: true,
          logoutTokens: [Buffer.from("arbitrary data here")],
        }),
      })
    );

    res.json({ type: 'succes', msg:'Код был отправлен!' });
  }
  catch(e){
    console.log(e)
    if(e.errorMessage === 'PHONE_NUMBER_INVALID'){
      res.json({ type: 'error', msg:'Ошибка в номере телефона!' });
    }
    else{
      res.json({ type: 'error', msg:e.errorMessage });
    }
    //await serverBase.updateOne({ id_server: SERVER.id_server}, { $inc : { current_users: -1 }});
    await CLIENTS[_hashCode].client.disconnect();
    await CLIENTS[_hashCode].client.destroy();
    delete CLIENTS[_hashCode];
  }
});

app.post('/auth/code-password', async (req, res) => {
  const { id, username, code, password } = req.body;

  const _hashCode = HASH_TABLE[id];




  CLIENTS[_hashCode].code = code.replaceAll(' ','');
  CLIENTS[_hashCode].password = password;
  try {   
    CLIENTS[_hashCode].resultCodeTg = await CLIENTS[_hashCode].client.invoke(
      new Api.auth.SignIn({
        phoneNumber: CLIENTS[_hashCode].phone,
        phoneCodeHash: CLIENTS[_hashCode].resultSendCode.phoneCodeHash,
        phoneCode: CLIENTS[_hashCode].code
      })
    );

    const me = await CLIENTS[_hashCode].client.getMe();
    const ACCOUNT = {  
      id_server: SERVER.id_server,
      id, hash: _hashCode,  account_id: me.id.value, account_username: me.username, isFrozen: false, isBanned: false,
      full_name: `${me.firstName ?? ''} ${me.lastName ?? ''}`, api_id: CLIENTS[_hashCode].api_id, api_hash: CLIENTS[_hashCode].api_hash,
      session: CLIENTS[_hashCode].client.session.save(), posts:[] 
    };

    await usersAppDB.insertOne(ACCOUNT);
    console.log(ACCOUNT);

    //await serverBase.updateOne({ id_server: ID_SERVER }, { $push: { "auth_users": ACCOUNT } });
    res.json({ type: 'succes', msg:'Вы были авторизованы!' });
  } catch (err) {
    if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      try{
        const passwordInfo = await CLIENTS[_hashCode].client.invoke(new Api.account.GetPassword());
        const password = await CLIENTS[_hashCode].password;
        const passwordSrp = await passwordUtils.computeCheck(passwordInfo, password);
        await CLIENTS[_hashCode].client.invoke( new Api.auth.CheckPassword({ password: passwordSrp }) );

        const me = await CLIENTS[_hashCode].client.getMe();

        const ACCOUNT = {  
          id_server: SERVER.id_server,
          id, hash: _hashCode,  account_id: me.id.value, account_username: me.username, isFrozen: false, isBanned: false,
          full_name: `${me.firstName ?? ''} ${me.lastName ?? ''}`, api_id: CLIENTS[_hashCode].api_id, api_hash: CLIENTS[_hashCode].api_hash,
          session: CLIENTS[_hashCode].client.session.save(), posts:[] 
        };

        await usersAppDB.insertOne(ACCOUNT);
       
        res.json({ type: 'succes', msg:'Вы были авторизованы!' });

      }
      catch(err2){
        if (err2.errorMessage === "PASSWORD_HASH_INVALID") {
          res.json({ type: 'error', msg:'Облачный пароль не совпадает!'});
          await CLIENTS[_hashCode].client.disconnect();
          await CLIENTS[_hashCode].client.destroy();
          delete CLIENTS[_hashCode];
        } 
      }
    } else {

      console.error("❌ Ошибка входа:", err);
      if (err.errorMessage === "PHONE_CODE_INVALID") {    
         res.json({ type: 'error', msg:'Код введен не правильно!'});
         await CLIENTS[_hashCode].client.disconnect();
         await CLIENTS[_hashCode].client.destroy();
         delete CLIENTS[_hashCode];
      }
    }

    if (err.errorMessage === "PHONE_CODE_EXPIRED") {
       res.json({ type: 'error', msg:'Время кода истекло!'});
       await CLIENTS[_hashCode].client.disconnect();
       await CLIENTS[_hashCode].client.destroy();
       delete CLIENTS[_hashCode];
    } 
  }

});





// Editor posts
app.post('/api/add-post', async (req, res) => {
  const { post_editor, hash } = req.body;

  const channel = await channelsDB.findOne({ channel_name: post_editor.channel_name });

  if(!channel){
    const data = await searchChannel( hash, post_editor );
    post_editor.channel = data?.channel;
    post_editor.chat = data?.chat;
  } else{
    post_editor.channel = channel.channel;
    post_editor.chat = channel.chat;
  }

  await usersAppDB.updateOne({ hash, "posts.id": post_editor.id }, { $set: { "posts.$": post_editor } });

    try{
      if(USERS[hash]){
        USERS[hash][post_editor.id] = post_editor;  
        USERS[hash][post_editor.id].handler = await createHandlerMessage(hash, post_editor.id, post_editor.channel, post_editor.chat);
        CLIENTS[hash].client.addEventHandler( USERS[hash][post_editor.id].handler, new NewMessage({ chats: [post_editor.chat] }) );

        const CLIENT = CLIENTS[hash].client;
        const channelEntity = await CLIENT.getEntity(post_editor.channel_name);
        await CLIENT.invoke(new Api.channels.JoinChannel({ channel: channelEntity }));
        const msgs = await CLIENT.getMessages(post_editor.channel_name, { limit: 42 });
        const msg = msgs.find((item, id) => {
          const it = +Number(item?.replies?.channelId?.value);
          if(it > 777){
            return item
          }  
        });
        const discussionChat = await CLIENT.getEntity(msg.replies.channelId);
        await CLIENT.invoke(new Api.channels.JoinChannel({ channel: discussionChat }));
      }
      else{
        const user = await usersAppDB.findOne({ hash });
        loginAccount(user);
      }
      //console.log(USERS[hash]);
    }
    catch(e){
      console.log(e);
    }
  

  console.log("FINSIH")
  res.json({ type: 200 });
});


app.post('/api/update-post', async (req, res) => {
  const { post_editor, hash } = req.body;

  const channel = await channelsDB.findOne({ channel_name: post_editor.channel_name });

  if(!channel){
    const data = await searchChannel( hash, post_editor );
    post_editor.channel = data?.channel;
    post_editor.chat = data?.chat;
  } else{
    post_editor.channel = channel.channel;
    post_editor.chat = channel.chat;
  } 
    await usersAppDB.updateOne({ hash, "posts.id": post_editor.id }, { $set: { "posts.$": post_editor } });
    try{
       if (USERS[hash]?.[post_editor.id]?.handler) {
        await CLIENTS[hash].client.removeEventHandler(USERS[hash][post_editor.id].handler, new NewMessage({ chats: [USERS[hash][post_editor.id].chat] }));
      }
      USERS[hash][post_editor.id] = await post_editor;  
      USERS[hash][post_editor.id].handler = await createHandlerMessage(hash, post_editor.id, post_editor.channel, post_editor.chat);
      await CLIENTS[hash].client.addEventHandler( USERS[hash][post_editor.id].handler, new NewMessage({ chats: [post_editor.chat] }));


      const CLIENT = CLIENTS[hash].client;
      const channelEntity = await CLIENT.getEntity(post_editor.channel_name);
      await CLIENT.invoke(new Api.channels.JoinChannel({ channel: channelEntity }));
      const msgs = await CLIENT.getMessages(post_editor.channel_name, { limit: 42 });
      const msg = msgs.find((item, id) => {
        const it = +Number(item?.replies?.channelId?.value);
        if(it > 777){
          return item
        }  
      });
      const discussionChat = await CLIENT.getEntity(msg.replies.channelId);
      await CLIENT.invoke(new Api.channels.JoinChannel({ channel: discussionChat }));
    }
    catch (e){
      console.log(e);
    }

  return res.json({ type: 200 });
});


app.post('/api/delete-post', async (req, res) => {
  const { hash_post, hash } = req.body;
  if (USERS[hash]?.[hash_post]?.handler) {
    await CLIENTS[hash].client.removeEventHandler(USERS[hash][hash_post].handler, new NewMessage({ chats: [USERS[hash][hash_post].chat] }))
    delete USERS[hash][hash_post];
  }
  res.json({ type: 200 });
});


app.post('/api/suspend-user', async (req, res) => {
  const { hash } = req.body;
  if (CLIENTS[hash]?.client) {
    console.log(`USER SUSPEND: ${hash}`);
    await CLIENTS[hash].client.disconnect();
    await CLIENTS[hash].client.destroy();
    delete CLIENTS[hash];
  }
  res.json({ type: 200 });
});


app.post('/api/restore-user', async (req, res) => {
  const { hash } = req.body;

  const AUTH_USERS = await usersAppDB.find({ id_server: ID_SERVER, hash }).toArray();
  AUTH_USERS.forEach(user => {
    if(!user.isBanned && !user.isFrozen){
      loginAccount(user);
    }
  });

  console.log(`USER RESTORE: ${hash}`);
  res.json({ type: 200 });
});


async function searchChannel(hash, post_editor) {
  try{
    const CLIENT = CLIENTS[hash].client;

    const channelEntity = await CLIENT.getEntity(post_editor.channel_name);
    await CLIENT.invoke(new Api.channels.JoinChannel({ channel: channelEntity }));
    const msgs = await CLIENT.getMessages(post_editor.channel_name, { limit: 42 });
    const msg = msgs.find((item, id) => {
      const it = +Number(item?.replies?.channelId?.value);
      if(it > 777){
        return item
      }  
    });

    const discussionChat = await CLIENT.getEntity(msg.replies.channelId);
    await CLIENT.invoke(new Api.channels.JoinChannel({ channel: discussionChat }));
  
  
    const dialogs = await CLIENT.getDialogs();
    
    const CHANNEL_ID = dialogs.find((chat) => chat.name === channelEntity.title);
    const CHAT_ID = dialogs.find((chat) => chat.name === discussionChat.title);
  
    const data = { channel_name: post_editor.channel_name, channel: Number(String(CHANNEL_ID?.inputEntity?.channelId)), chat: Number(String(CHAT_ID?.id)) };
    await channelsDB.insertOne(data);
    data.type = 'success'; 
    return data;
    
  }
  catch(e){
    console.log(e);
    return { type: 'error' }
  }

}

// Login Account Telegram
async function createHandlerMessage(hash, id_post, channel, chat){
  // console.log('CREATE HANDLER: ', hash, id_post, channel, chat);
  return async function(event){
    const message = event.message;
    if (Number(message.chatId.valueOf()) !== chat) return;
    if (message.fwdFrom && message.fwdFrom.channelPost && message.fwdFrom.fromId.className === "PeerChannel" && Number(message.fwdFrom.fromId.channelId) === channel) {

      console.log('MESSAGE: ',message.groupedId);
      if(message.groupedId && !CLIENTS[hash].groupedId){
        console.log('MESSAGE: ', Number(String(message.groupedId)));
        CLIENTS[hash].groupedId = Number(String(message.groupedId));
        delay(USERS[hash][id_post].delay).then( async () => {
          try {
            await CLIENTS[hash].client.sendMessage(chat, {
              file: USERS[hash][id_post].post_image,
              message: USERS[hash][id_post].post_text,
              parseMode: "html",
              replyTo: message.id
            });
          } catch (err) {
            axios.post(process.env.URL_BOT+'/telegram/send-text', { id: USERS[hash].id, text: `<b>❌ Ошибка при отправке сообщения в канал  @${USERS[hash][id_post].channel_name}:</b> \n <blockquote>${err.errorMessage}</blockquote>` })
            console.error("❌ Ошибка при отправке сообщения:", err);
         }
       })  
      }
      else if(!message.groupedId){
        console.log('MESSAGE WITHOUT groupedId');
        delay(USERS[hash][id_post].delay).then( async () => {
          //console.log('DATA MESSAGE :', USERS[hash][id_post].post_image, USERS[hash][id_post].post_text);
          try {
            await CLIENTS[hash].client.sendMessage(chat, {
              file: USERS[hash][id_post].post_image,
              message: USERS[hash][id_post].post_text,
              parseMode: "html",
              replyTo: message.id
            });
          } catch (err) {
            axios.post(process.env.URL_BOT+'/telegram/send-text', { id: USERS[hash].id, text: `<b>❌ Ошибка при отправке сообщения в канал  @${USERS[hash][id_post].channel_name}:</b> \n <blockquote>${err.errorMessage}</blockquote>` })
            console.error("❌ Ошибка при отправке сообщения:", err);
         }
       })  
      }
        
      
  } }
}

async function loginAccount({ session, hash, posts, api_id, api_hash, id  }) {
  try {
    USERS[hash] = {};
    CLIENTS[hash] = {};
    USERS[hash].id = id;

    if(api_id){
      CLIENTS[hash].api_id = +api_id;
      CLIENTS[hash].api_hash = api_hash;
    }else{
      CLIENTS[hash].api_id = +SERVER.API_ID;
      CLIENTS[hash].api_hash = SERVER.API_HASH;
    }


    CLIENTS[hash].client = new TelegramClient(new StringSession(session), CLIENTS[hash].api_id, CLIENTS[hash].api_hash, { connectionRetries: 5 });
    await CLIENTS[hash].client.start();
    
    for(const post of posts){
      USERS[hash][post.id] = post;
      await runNotifucation(post);
    }

    async function runNotifucation(post) {
      try{
        USERS[hash][post.id].handler = await createHandlerMessage(hash, post.id, post.channel, post.chat);
        CLIENTS[hash].client.addEventHandler( USERS[hash][post.id].handler, new NewMessage({ chats: [post.chat] }));
      }
      catch(e){
        console.log(e);
      }
    }

  } catch (err) {
    //console.log(session);
    //dataBase.deleteOne({ session })
    console.error("❌ Непредвиденная ошибка:", err);
  }
}





// StartApp here
async function startApp(){
  SERVER = await serversDB.findOne({ id_server: ID_SERVER });
  const AUTH_USERS = await usersAppDB.find({ id_server: ID_SERVER }).toArray();
  AUTH_USERS.forEach(user => {
    if(!user.isBanned && !user.isFrozen){
      loginAccount(user);
    }
  });
}
startApp();

function hashCode(n = 8) {
  const symbols = "QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm1234567890";
  let user_hash = "";
  for (let i = 0; i != n; i++) {
    user_hash += symbols[Math.floor(Math.random() * symbols.length)];
  }
  return user_hash;
}


// ids


app.listen(3057, (err) => {
  err ? err : console.log("STARTED SERVER");
});
