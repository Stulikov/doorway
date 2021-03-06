const http = require('http');
const fs = require('fs');
const qs = require('querystring');
const gpio = require('rpi-gpio');
const requestIp = require('request-ip');
const db = require('node-localdb');

const debug = true;

const ethalonToken = process.env.BACKDOOR_ETHALON_TOKEN;
const ethalonTeamID = process.env.BACKDOOR_ETHALON_TEAM_ID;
const port = process.env.BACKDOOR_PORT || 8081;

// CAFE, SMOKE, SORTIR
const gpios = [11, 13, 15];
const gpiosReadyStates = [false, false, false];

const logfile = '/home/pi/doorway/log.txt';
const users = db('/home/pi/doorway/users.json');

function logOpener(line) {
  const time = (new Date()).toLocaleTimeString();
  fs.appendFile(logfile, `${time} ${line}\n`, (err) => {
    if (err) throw err;
  });
  if (debug) {
    console.log(`${time}: ${line}`);
  }
}

function initDoor(i) {
  gpio.setup(gpios[i], gpio.DIR_OUT, gpio.EDGE_NONE, () => {
    gpiosReadyStates[i] = true;
    console.log('GPIO ready state', gpiosReadyStates[i]);
  });
}

function gpioInit() {
  gpio.destroy(() => {
    console.log('All pins unexported.');
    for (let i = 0; i < gpios.length; i += 1) {
      gpiosReadyStates[i] = false;
      initDoor(i);
    }
  });
}
gpioInit();

function addUser(userID, userName, callback) {
  users.findOne({ userid: userID }).then((u) => {
    if (u) {
      let accessTxt = '';
      if (u.access) { accessTxt = ', access allowed'; } else { accessTxt = ', access denied, ask boss to get an access.'; }

      let adminTxt = '';
      if (u.admin) { adminTxt = ', admin'; }

      callback([false, `User already exist${accessTxt}${adminTxt}.`]);
    } else {
      users.insert({
        userid: userID,
        username: userName,
        access: false,
        admin: false,
      }).then((au) => {
        console.log(`Added user: ${au}`);
        callback([true, `You added as ${au.username}`]);
      });
    }
  });
}

function accessAllowed(data, dbCallback) {
  let result = 0;
  if (data.token === ethalonToken && data.team_id === ethalonTeamID) {
    result = 1;
  }
  users.findOne({ userid: data.user_id }).then((u) => {
    if (u) {
      if (u.access) {
        result = 2;
        if (u.admin) {
          result = 3;
        }
      }
    }
    console.log(result);
    dbCallback(result);
  });
}

function listUsers(dbCallback) {
  users.find({}).then((us) => {
    let result = '';
    for (let i = 0; i < us.length; i += 1) {
      const accessTxt = us[i].access ? ' allowed' : ' disabled';
      const adminTxt = us[i].admin ? ' admin' : '';
      result += `${us[i].userid}: ${us[i].username}${accessTxt}${adminTxt}\n`;
    }
    console.log(result);
    dbCallback([true, result]);
  });
}

function userPermissions(params, dbCallback) {
  const { userID } = params;
  users.findOne({ userid: userID }).then((u) => {
    if (u) {
      let userName = u.username;
      if (typeof (params.user_name) !== 'undefined') {
        userName = params.user_name;
      }
      let { access } = u;
      if (typeof (params.access) !== 'undefined') {
        access = params.access;
      }
      let { admin } = u;
      if (typeof (params.admin) !== 'undefined') {
        admin = params.admin;
      }

      users.remove({ userid: userID }).then(() => {
        users.insert({
          userid: userID, username: userName, access, admin,
        }).then((au) => {
          console.log('User was changed: ', au);
          let accessTxt = '';
          if (access !== u.access) {
            accessTxt = access ? ' now allowed to open doors' : ' now prohibited to open doors';
          }
          let adminTxt = '';
          if (admin !== u.admin) {
            adminTxt = admin ? ' now admin' : ' now not admin';
          }
          if (accessTxt === '' && adminTxt === '') {
            adminTxt = ': nothing to change. Everything is up to date';
          }
          dbCallback([true, `${userName + accessTxt + adminTxt}.`]);
        });
      });
    } else {
      dbCallback([true, "Such user doesn't exist."]);
    }
  });
}

function openDoor(doorID) {
  console.log('open door ', gpiosReadyStates, doorID);
  if (gpiosReadyStates[doorID]) {
    gpio.write(gpios[doorID], 1, (err) => {
      if (err) {
        console.log('Error on GPIO write 1: ', err.message);
      }
      console.log(`Asking to open door #${doorID}`);

      setTimeout(() => {
        gpio.write(gpios[doorID], 0, (e) => {
          if (e) {
            console.log('Error on GPIO write 0: ', err.message);
          }
        });
      }, 200);
    });
  } else {
    console.log(`GPIO port #${gpios[doorID]} isn't ready to operate.`);
  }
}

function processRequest(data, IP, request, callback) {
  accessAllowed(data, (result) => {
    if (result >= 2) {
      logOpener(`IP: ${IP} user_id: ${data.user_id}; parsed command: ${data.command}; ` +
                `auth result: authorized; request.url: ${request.url}`);
      if (data.command === '/door_cafe' || data.command === '/t') {
        openDoor(0);
        callback([true, 'Opening CAFE side door']);
      } else if (data.command === '/door_smoke' || data.command === '/y') {
        openDoor(1);
        callback([true, 'Opening SMOKE side door']);
      } else if (data.command === '/door_sortir' || data.command === '/u') {
        openDoor(2);
        callback([true, 'Opening SORTIR side door']);
      } else if (data.command === '/door_update_my_name') {
        userPermissions({ userID: data.user_id, userName: data.user_name }, callback);
      } else if (data.command === '/da_list_users') {
        if (result === 3) {
          listUsers(callback);
        } else {
          callback([false, 'You are not admin, access denied.']);
        }
      } else if (data.command === '/da_grant_permissions') {
        if (result === 3) {
          userPermissions({ userID: data.text, access: true }, callback);
        } else {
          callback([false, 'You are not admin, access denied.']);
        }
      } else if (data.command === '/da_revoke_permissions') {
        if (result === 3) {
          userPermissions({ userID: data.text, access: false }, callback);
        } else {
          callback([false, 'You are not admin, access denied.']);
        }
      } else if (data.command === '/da_make_admin') {
        if (result === 3) {
          userPermissions({ userID: data.text, admin: true }, callback);
        } else {
          callback([false, 'You are not admin, access denied.']);
        }
      } else if (data.command === '/da_disrank_admin') {
        if (result === 3) {
          userPermissions({ userID: data.text, admin: false }, callback);
        } else {
          callback([false, 'You are not admin, access denied.']);
        }
      } else {
        if (debug) { console.log('wrong command'); }
        logOpener(`IP: ${IP} user_id: ${data.user_id}; parsed command: ${data.command}; ` +
                  `auth result: authorized, wrong command; request.url: ${request.url}`);
        callback([false, 'wrong command']);
      }
    } else if (result === 1 && data.command === '/door_give_me_access') {
      addUser(data.user_id, data.user_name, callback);
    } else {
      if (debug) { console.log('not authorized'); }
      logOpener(data.user_id, data.command, 'not authorized', IP);
      callback([false, 'not authorized']);
    }
  });
  console.log('', data);
}

http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' });

  if (request.method === 'POST') {
    let body = '';
    request.on('data', (data) => {
      body += data;
    });
    request.on('end', () => {
      const obj = qs.parse(body);
      if (debug) { console.log(obj); }
      const IP = requestIp.getClientIp(request);
      processRequest(obj, IP, request, (result) => {
        if (result[0]) {
          response.end(result[1]);
        } else {
          response.end(':pashak2:');
        }
      });
    });
  } else {
    response.end('nothing');
  }
}).listen(port, '127.0.0.1');

console.log(`Server running at port ${port}; Token: ${ethalonToken} Team ID: ${ethalonTeamID}.`);
logOpener(`Server running at port ${port}; Token: ${ethalonToken} Team ID: ${ethalonTeamID}.`);
