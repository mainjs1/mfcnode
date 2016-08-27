'use strict';
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var yaml = require('js-yaml');
var moment = require('moment');
var mkdirp = require('mkdirp');
var S = require('string');
var WebSocketClient = require('websocket').client;
var http = require('http');
var colors = require('colors');
var _ = require('underscore');
var childProcess = require('child_process');
var path = require('path');

function getCurrentDateTime() {
  return moment().format('YYYY-MM-DDTHHmmss'); // The only true way of writing out dates and times, ISO 8601
};

function printMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), msg);
}

function printErrorMsg(msg) {
  console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.red('[ERROR]'), msg);
}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.blue('[' + getCurrentDateTime() + ']'), colors.yellow('[DEBUG]'), msg);
  }
}

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

function dumpModelsCurrentlyCapturing() {
  _.each(modelsCurrentlyCapturing, function(m) {
    printDebugMsg(colors.red(m.pid) + "\t" + m.checkAfter + "\t" + m.filename + "\t" + m.size + ' bytes');
  });
}

function getFileno() {
  return new Promise(function(resolve, reject) {
    var client = new WebSocketClient();

    client.on('connectFailed', function(err) {
      reject(err);
    });

    client.on('connect', function(connection) {

      connection.on('error', function(err) {
        reject(err);
      });

      connection.on('message', function(message) {
        if (message.type === 'utf8') {
          var parts = /\{%22fileno%22:%22([0-9_]*)%22\}/.exec(message.utf8Data);

          if (parts && parts[1]) {
            printDebugMsg('fileno = ' + parts[1]);

            connection.close();
            resolve(parts[1]);
          }
        }
      });

      connection.sendUTF("hello fcserver\n\0");
      connection.sendUTF("1 0 0 20071025 0 guest:guest\n\0");
    });

    client.connect('ws://xchat20.myfreecams.com:8080/fcsl', '', 'http://xchat20.myfreecams.com:8080', {Cookie: 'company_id=3149; guest_welcome=1; history=7411522,5375294'});
  }).timeout(30000); // 30 secs
}

function getOnlineModels(fileno) {
  return new Promise(function(resolve, reject) {
    var url = 'http://www.myfreecams.com/mfc2/php/mobj.php?f=' + fileno + '&s=xchat20';

    printDebugMsg(url);

    http
      .get(url, function(response) {
        var rawHTML = '';

        if (response.statusCode == 200) {
          response.on('data', function(data) {
            rawHTML += data;
          });

          response.on('end', function() {
            try {
              rawHTML = rawHTML.toString('utf8');
              rawHTML = rawHTML.substring(rawHTML.indexOf('{'), rawHTML.indexOf("\n") - 1);
              rawHTML = rawHTML.replace(/[^\x20-\x7E]+/g, '');

              var data = JSON.parse(rawHTML);

              var onlineModels = [];

              for (var key in data) {
                if (data.hasOwnProperty(key) && typeof data[key].nm != 'undefined' && typeof data[key].uid != 'undefined') {
                  onlineModels.push({
                    nm: data[key].nm,
                    uid: data[key].uid,
                    vs: data[key].vs,
                    camserv: data[key].u.camserv,
                    camscore: data[key].m.camscore,
                    new_model: data[key].m.new_model
                  });
                }
              }

              printMsg(onlineModels.length  + ' model(s) online');

              resolve(onlineModels);
            } catch (err) {
              reject(err);
            }
          });
        } else {
          reject('Invalid response: ' + response.statusCode);
        }
      })
      .on('error', function(err) {
        reject(err);
      });
  }).timeout(30000); // 30 secs
}

function selectMyModels(onlineModels) {
  return Promise
    .try(function() {
      printDebugMsg(config.models.length + ' model(s) in config');

      var dirty = false;
      var stats = fs.statSync('updates.yml');

      if (stats.isFile()) {
        var updates = yaml.safeLoad(fs.readFileSync('updates.yml', 'utf8'));

        if (!updates.includeModels) {
          updates.includeModels = [];
        }

        if (!updates.excludeModels) {
          updates.excludeModels = [];
        }

        // first we push changes to main config
        if (updates.includeModels.length > 0) {
          printMsg(updates.includeModels.length + ' model(s) to include');

          config.includeModels = _.union(config.includeModels, updates.includeModels);
          dirty = true;
        }

        if (updates.excludeModels.length > 0) {
          printMsg(updates.excludeModels.length + ' model(s) to exclude');

          config.excludeModels = _.union(config.excludeModels, updates.excludeModels);
          dirty = true;
        }

        // if there were some updates, then we reset updates.yml
        if (dirty) {
          updates.includeModels = [];
          updates.excludeModels = [];

          fs.writeFileSync('updates.yml', yaml.safeDump(updates), 0, 'utf8');
        }
      }

      // we go through the list on models we want to "include",
      // if we could not find "include" model in the collection of online models then we skip this model till the next time,
      // otherwise
      // if this model is already in our config.models we remove "excluded" flag if it was set before,
      // if this model is not in our config.models we "push" her in config.models
      config.includeModels = _.reject(config.includeModels, function(nm) {
        var onlineModel = _.findWhere(onlineModels, {nm: nm});

        if (!onlineModel) { // skip
          return false;
        }

        // 1st we look for existing record of this model in config.models
        var myModel = _.findWhere(config.models, {uid: onlineModel.uid});

        if (!myModel) { // if there is no existing record then we "push"
          config.models.push({
            uid: onlineModel.uid,
            nm: onlineModel.nm
          });

          dirty = true;
        } else if (!!myModel.excluded) { // if the model was "excluded" before we "include" her back
          delete myModel.excluded;

          dirty = true;
        }

        return true;
      });

      // we go through the list on models we want to "exclude",
      // if we could not find "exclude" model in the collection of online models then we skip this model till the next time,
      // otherwise
      // if this model is already in our config.models we set "excluded" flag if it was set before,
      // if this model is not in our config.models we "push" her in config.models, but mark her as "excluded"
      config.excludeModels = _.reject(config.excludeModels, function(nm) {
        var onlineModel = _.findWhere(onlineModels, {nm: nm});

        if (!onlineModel) { // skip
          return false;
        }

        var myModel = _.findWhere(config.models, {uid: onlineModel.uid});

        if (!myModel) { // if there is no existing record then we "push"
          config.models.push({
            uid: onlineModel.uid,
            nm: onlineModel.nm,
            excluded: true
          });

          dirty = true;
        } else if (!myModel.excluded) { // then we "exclude" the model
          myModel.excluded = true;

          dirty = true;
        }

        return true;
      });

      var myModels = [];

      _.each(config.models, function(myModel) {
        var onlineModel = _.findWhere(onlineModels, {uid: myModel.uid});

        if (onlineModel) {
          // if the model does not have a name in config.models we use her name by default
          if (!myModel.nm) {
            myModel.nm = onlineModel.nm;

            dirty = true;
          }

          if (!myModel.excluded) {
            // override model's name by the name from config
            onlineModel.nm = myModel.nm;

            if (onlineModel.vs === 0) {
              myModels.push(onlineModel);
            } else {
              printMsg(colors.magenta(onlineModel.nm) + ' is away or in a private');
            }
          }
        }
      });

      if (dirty) {
        printDebugMsg('Save changes in config.yml');

        fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
      }

      printDebugMsg(myModels.length  + ' model(s) to capture');

      return myModels;
    });
}

function createCaptureProcess(model) {
  var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {uid: model.uid});

  if (!!modelCurrentlyCapturing) {
    printDebugMsg(colors.green(model.nm) + ' is already capturing');
    return; // resolve immediately
  }

  printMsg(colors.green(model.nm) + ' is now online, starting capturing process');

  return Promise
    .try(function() {
      var filename = model.nm + '_' + getCurrentDateTime() + '.ts';

      var spawnArguments = [
        '-hide_banner',
        '-v',
        'fatal',
        '-i',
        'http://video' + (model.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + model.uid) + '.f4v_mobile/playlist.m3u8?nc=1423603882490',
        // 'http://video' + (model.camserv - 500) + '.myfreecams.com:1935/NxServer/mfc_' + (100000000 + model.uid) + '.f4v_aac/playlist.m3u8?nc=1423603882490',
        '-c',
        'copy',
        config.captureDirectory + '/' + filename
      ];

      var captureProcess = childProcess.spawn('ffmpeg', spawnArguments);

      captureProcess.stdout.on('data', function(data) {
        printMsg(data.toString);
      });

      captureProcess.stderr.on('data', function(data) {
        printMsg(data.toString);
      });

      captureProcess.on('close', function(code) {
        printMsg(colors.green(model.nm) + ' stopped streaming');

        var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {pid: captureProcess.pid});

        if (!!modelCurrentlyCapturing) {
          var modelIndex = modelsCurrentlyCapturing.indexOf(modelCurrentlyCapturing);

          if (modelIndex !== -1) {
            modelsCurrentlyCapturing.splice(modelIndex, 1);
          }
        }

        fs.stat(config.captureDirectory + '/' + filename, function(err, stats) {
          if (err) {
            if (err.code == 'ENOENT') {
              // do nothing, file does not exists
            } else {
              printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
            }
          } else if (stats.size === 0) {
            fs.unlink(config.captureDirectory + '/' + filename);
          } else {
            fs.rename(config.captureDirectory + '/' + filename, config.completeDirectory + '/' + filename, function(err) {
              if (err) {
                printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
              }
            });
          }
        });
      });

      if (!!captureProcess.pid) {
        modelsCurrentlyCapturing.push({
          nm: model.nm,
          uid: model.uid,
          filename: filename,
          captureProcess: captureProcess,
          pid: captureProcess.pid,
          checkAfter: getTimestamp() + 600, // we are gonna check the process after 10 min
          size: 0
        });
      }
    })
    .catch(function(err) {
      printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
    });
}

function checkCaptureProcess(model) {
  if (!model.checkAfter || model.checkAfter > getTimestamp()) {
    // if this is not the time to check the process then we resolve immediately
    printDebugMsg(colors.green(model.nm) + ' - OK');
    return;
  }

  // printDebugMsg(colors.green(model.nm) + ' should be checked');

  return fs
    .statAsync(config.captureDirectory + '/' + model.filename)
    .then(function(stats) {
      // we check the process every 10 minutes since the its start,
      // if the size of the file has not changed over the time, we kill the process
      if (stats.size - model.size > 0) {
        printDebugMsg(colors.green(model.nm) + ' - OK');

        modelsCurrentlyCapturing.forEach(function(m) {
          if (m.uid == model.uid && m.pid == model.pid) {
            m.checkAfter = getTimestamp() + 600; // 10 minutes
            m.size = stats.size;
          }
        });
      } else if (!!model.captureProcess) {
        // we assume that onClose will do clean up for us
        printErrorMsg('[' + colors.green(model.nm) + '] Process is dead');
        model.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from modelsCurrentlyCapturing
        // because her captureProcess is unset, but let's leave this as is
      }
    })
    .catch(function(err) {
      if (err.code == 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
      }
    });
}

function mainLoop() {
  printDebugMsg('Start searching for new models');

  Promise
    .try(function() {
      return getFileno();
    })
    .then(function(fileno) {
      return getOnlineModels(fileno);
    })
    .then(function(onlineModels) {
      return selectMyModels(onlineModels);
    })
    .then(function(myModels) {
      return Promise.all(myModels.map(createCaptureProcess));
    })
    .then(function() {
      printDebugMsg('checkCaptureProcess');
      return Promise.all(modelsCurrentlyCapturing.map(checkCaptureProcess));
    })
    .catch(function(err) {
      printErrorMsg(err);
    })
    .finally(function() {
      dumpModelsCurrentlyCapturing();

      printMsg('Done, will search for new models in ' + config.modelScanInterval + ' second(s).');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

var modelsCurrentlyCapturing = new Array();

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = path.resolve(config.captureDirectory);
config.completeDirectory = path.resolve(config.completeDirectory);

mkdirp(config.captureDirectory, function(err) {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

mkdirp(config.completeDirectory, function(err) {
  if (err) {
    printErrorMsg(err);
    process.exit(1);
  }
});

// convert the list of models to the new format
var dirty = false;

if (config.models.length > 0) {
  config.models = config.models.map(function(m) {

    if (typeof m === 'number') { // then this "simple" uid
      dirty = true;
      m = {uid: m};
    }

    return m;
  });
}

if (dirty) {
  printDebugMsg('Update config.yml');

  fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');
}

mainLoop();
