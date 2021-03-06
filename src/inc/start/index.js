const util = require('./../util');
// const chalk = require('chalk');

module.exports = async function ( config ) {

  // configure the logging ASAP...
  var exLog = console.log;
  console.log = function() {
    let timestamp = new Date().toISOString();
    Array.prototype.unshift.call(arguments, timestamp);
    exLog.apply(this, arguments);
  };

  // Output the software names and versions...
  console.log(`${config.acter.server.name} v${config.acter.server.version}`,
    `running ${config.acter.app.name} v${config.acter.app.version}`);

  const debug = require('debug')('acter:start');
  debug('Booting...');
  // const {app, express, socketio, memory, authentication} = require('./server')(config);
  const {server, app, express, authentication} = require('./server')(config);

  // Make config available to services via context.app.get('config')
  app.set('config', config);
  debug('Server loaded.');

  // Load the main persistence connection...
  const data = await require('./persistence')(config.acter.server.persistence);
  debug('Persistence loaded.');

  // Log any hooks present...
  let hooks = ['before', 'after', 'error'];
  let hooksFound = [];
  hooks.forEach(aspect => {
    let aspectPath = util.resolve(`src/hooks/${aspect}.js`);
    if (util.exists(aspectPath)) {
      hooksFound.push(aspect);
    } 
  });
  if (hooksFound.length) {
    console.log(`Found ${hooksFound.length} hook(s):`, hooksFound);
  } else {
    console.log('No hooks present');
  }
  
  // See if we're hosting statics...
  if (config.acter.server.statics.active === true) {
    let statics = config.acter.server.statics;
    let folder = util.resolve(statics.folder);
    console.log(`Hosting static files at ${statics.endpoint} from ${folder}`);
    app.use(statics.endpoint, express.static(folder));
  }

  // See if we're watching something...
  if (config.acter.server.watch.active === true) {
    let watch = config.acter.server.watch;
    let folder = watch.folder;
    let report = util.resolve(watch.report);
    if (util.exists(folder)) {
      let watcher = util.watch(folder);
      if (util.exists(report) || util.exists(report + '/index.js')) {
        console.log(`Watching ${folder} for changes and telling ${report}.`);
        require(report)({app, watcher, config, util});
      } else {
        console.log(`Watch report source code (${report}) does not exist!`);
      }
    } else {
      console.log(`Can't find watch folder: "${folder}". Please create it or change config.`);
    }
  }

  // Load the service loader...
  const loadService = require('./service')(config, app, data);
  var services = {};
  debug('loading services');

  // Setup each enabled service...
  let definitions = config.acter.services.definitions;
  let definedUsers = false;
  Object.keys(definitions).forEach(name => {
    let service = definitions[name];
    debug('Loading service', name);
    services[name] = loadService(name, service);
    if (name === 'users') definedUsers = true;
  });
  debug('Services loaded.');

  // Now load the authentication service...
  app.configure(authentication.auth({ secret: config.acter.secrets.auth }))
    .configure(authentication.local())
    .configure(authentication.jwt());

  app.use(express.errorHandler());

  const ports = { from: 0, to: 0 };

  // Log that we're about to start listening...
  if (Number.isInteger(config.acter.server.port)) {
    debug('Trying port', config.acter.server.port);
    ports.from = config.acter.server.port;
    ports.to = config.acter.server.port;

  } else {
    ports.from = config.acter.server.port.from;
    ports.to = config.acter.server.port.to;
    debug(`Finding free port between ${ports.from} and ${ports.to}`);
  }

  // Add the user to the authentication service (will only return the JWT otherwise)
  app.service('authentication').hooks({
    before: {
      create: [
        // You can chain multiple strategies
        authentication.auth.hooks.authenticate(['jwt', 'local'])
      ],
      remove: [
        authentication.auth.hooks.authenticate('jwt')
      ]
    },
    after: {
      create: [
        (context) => {
          context.result.user = context.params.user;
          delete context.result.user.password;
        }
      ]
    }
  });

  // See if users have been defined...
  if (!definedUsers) {
    console.log('Users must be defined. Creating them.');
    loadService('users', { model: 'users', auto: true } );
  }

  // Make sure `password` never gets sent to the client
  app.service('users').hooks({
    after: authentication.local.hooks.protect('password'),
    before: {
      create: [
        authentication.local.hooks.hashPassword()
      ]
    }
  });
  
  // Start listening...
  const portfinder = require('portfinder');
  portfinder.getPort({
    port: ports.from,
    stopPort: ports.to
  }, (err, port) => {
    if (err) {
      console.log('Unable to get a free port.  Please change your settings.');
      console.log('https://github.com/onexdata/reaction-gateway#config-options');
      console.log('Your current port settings are:', config.acter.server.port);
      process.exit(-1);
    }
    debug('About to listen');
    server.listen(port);
    app.setup(server)
    console.log(`Listening on ${port}`);
  });

  return {server, app, services};
};
