"use strict";
// peer.js

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var fs = require('fs');
var url = require('url');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var NodeRSA = require('node-rsa');
const EventEmitter = require('events');

var WebSocketServer = require('websocket').server;
var WebSocketClient = require('websocket').client;

const PeerMessage = require('./message.js');

const getClassName = function(o) {
  let r = /function (.{1,})\(/.exec(o.constructor.toString());
  return (r && r.length > 1 ? r[1] : false);
};

module.exports = class Peer extends EventEmitter {
  
  constructor({
    httpsServer         = false,
    credentials         = { 'key': "https.key.pem", 'cert': "https.cert.pem" },
    port                = process.env.RINGNET_LISTEN || 26781,
    publicAddress       = false,
    discoveryAddresses  = [],
    discoveryRange      = [26780, 26790],
    startDiscovery      = true,
    publicKey           = "peer.pub",
    privateKey          = "peer.pem",
    ringPublicKey       = "ring.pub",
    signature           = "peer.signature",
    requireConfirmation = true,
    debug               = false
  }) {
    super();
    var self = this;
    
    // Set defaults on self
    self.httpsServer = httpsServer;
    self.discoveryAddresses = [];
    self.startDiscovery = startDiscovery;
    self.peers = [];
    self.publicAddress = publicAddress;
    self.port = port;
    self.debug = debug;
    self.requireConfirmation = requireConfirmation;
    self.range = discoveryRange;
    self.ready = false;
    self.discovering = false;
    self.closing = false;
    
    // We will be cycling through 'checks' in order to make sure we are given the correct
    // files needed to create this peer.
    let checks = [{ // We require a ring public key to join the network
      description: "Ring Public Key",
      location: ringPublicKey
    }, { // We require a valid signature to join and to validate peers on the network
      description: "Signature",
      location: signature
    }];
    
    // If we're not provided a valid 'httpsServer' option, check to make sure we 
    // are at least given HTTPS credentials in order to create a HTTPS server later
    if(!self.httpsServer || getClassName(self.httpsServer) !== "Server") {
      if(self.debug) {
        console.log("A valid 'httpsServer' option was not given; the 'credentials' option will be " +
          "checked for valid HTTPS credentials instead.");
      }
      
      checks.concat([{ // We require a valid signature to join and to validate peers on the network
        description: "HTTPS Server Key",
        location: credentials.key || "https.key.pem"
      }, { // We require a valid signature to join and to validate peers on the network
        description: "HTTPS Server Certificate",
        location: credentials.cert || "https.cert.pem"
      }]); 
    } else {
      if(self.debug) {
        console.log("A valid 'httpsServer' option given; the 'credentials' option will be " +
          "IGNORED.");
      }
    }
    
    checks.forEach((f) => {
      if(self.debug)
        console.log(`Checking for ${f.description} at ${f.location}`);
        
      // Make sure we have all the files necessary.
      if(!fs.existsSync(f.location)) {
        throw new Error(`Invalid ${f.description} file location (given: ${f.location}).`);
      }
    });
    
    // Peep the addresses variable for valid, given discovery addresses, adding
    // them to self.discoveryAddresses as we go...
    for(let i=0; i<discoveryAddresses.length; i++) {
      if(typeof discoveryAddresses[i] == "string") {
        self.discoveryAddresses.push({
          'address': discoveryAddresses[i],
          'signature': null
        });
      } else if(typeof discoveryAddresses[i] == "object") {
          self.discoveryAddresses.push({
            'address': discoveryAddresses[i].hasOwnProperty("address") ? 
              discoveryAddresses[i].address : null,
            'signature': discoveryAddresses[i].hasOwnProperty("signature") ? 
              discoveryAddresses[i].signature : null
          });
      }
    }
    
    // If peer private key file exists, then read it. Else, generate private
    self.privateKeyLocation = privateKey;
    self.privateKey = fs.existsSync(privateKey) ?
      new NodeRSA(fs.readFileSync(privateKey)) : new NodeRSA({ b: 2048 });
      
    // If peer public key file exists, then read it. Else, generate public from self.privateKey
    self.publicKeyLocation = publicKey;
    self.publicKey = fs.existsSync(publicKey) ?
      new NodeRSA(fs.readFileSync(publicKey)) : new NodeRSA(self.privateKey.exportKey("public"));
      
    // Read the ringPublicKey (this is required to exist)
    self.ringPublicKeyLocation = ringPublicKey;
    self.ringPublicKey = new NodeRSA(fs.readFileSync(ringPublicKey));
    
    // Read the signature file (this is required to exist)
    self.signatureLocation = signature;
    self.signature = fs.readFileSync(signature);
    
    // Read the HTTPS Server key (this is required to exist)
    self.httpsKeyLocation = credentials.key;
    self.httpsKey = fs.readFileSync(credentials.key, 'utf8');
    
    // Read the HTTPS Server key (this is required to exist)
    self.httpsCertLocation = credentials.cert;
    self.httpsCert = fs.readFileSync(credentials.cert, 'utf8');
    
    // Check to make sure that our signature is verifiable by the ring PUBLIC key
    // In other words, check to make sure the signature was generated by ring PRIVATE key
    // from our peer PUBLIC key. If not, we're probably not going to be allowed on the network
    // so we will have to abort peer creation altogether.
    if(!self.ringPublicKey.verify(self.publicKey.exportKey("public"), self.signature)) {
      throw new Error("Invalid signature for given peer public key and ring public key.");
    }
    
    if(self.debug) {
      console.log(`Peer signature (last 50 bytes): ` +
        `\n\t${self.signature.slice(-50).toString("base64")}`);
    }
    
    // We weren't given an 'httpsServer' via constructor arguments -- We need to create one
    if(!self.httpsServer || getClassName(self.httpsServer) !== "Server") {
      if(self.debug) console.log("Creating HTTPS server...");
      // Create the httpsServer (dummy)
      self.httpsServer = https.createServer({
        'key': self.httpsKey,
        'cert': self.httpsCert
      }, (request, response) => {
        // process HTTP request. Since we're writing just WebSockets
        // server we don't have to implement anything.
        response.end();
      });
    } else {
      if(self.debug) console.log(`HTTPS server already created.`);
    }
    
    if(self.httpsServer.address() === null) {
      if(self.debug) console.log(`Starting HTTPS server listening on ${self.port}...`);
      // Server isn't already listening (possible created from 'if' block direcrtly above)
      // so we need to tell it to start listening on port defined by 'port'
      self.httpsServer.listen(self.port, () => {
        if(self.debug) console.log(`Server listening on ${self.port}`);
        self.emit('ready');
        self.ready = true;
      });
    } else {
      self.port = self.httpsServer.address().port;
      if(self.debug) console.log(`HTTPS server already listening on ${self.port}.`);
      // Server is already listening, emit ready and set the ready flag to true
      self.emit('ready');
      self.ready = true;
    }
    
    // Create the WebSocket server
    self.wsServer = new WebSocketServer({
      httpServer: self.httpsServer,
      // maxReceivedFrameSize: 64 * 1024 * 1024, //64MiB
      // maxReceivedMessageSize: 64 * 1024 * 1024, //64MiB
      // fragmentOutgoingMessages: false,
      keepAlive: true,
      autoAcceptConnections: false,
      ignoreXForwardedFor: false
    });
    
    // WebSocket server
    self.wsServer.on('request', function(request) {
      if(self.debug) {
        console.log("New server connection...");
        // returns incorrect ip on open shift
        console.log("\trequest.remoteAddress = " + request.remoteAddress);
        // undefined on open shift
        console.log("\trequest.httpRequest.headers['x-forwarded-for'] = " + request.httpRequest.headers['x-forwarded-for']);
      }
      
      let connection = request.accept(null, request.origin);
      
      self.emit('request', { connection, request });
      self.setupConnection({ connection, request });
    });
    
    if(self.startDiscovery) self.discover();
  }
  
  discover() {
    if(!this.discoveryAddresses || this.discoveryAddresses.length < 1) {
      this.discovering = false;
      this.emit('discovered');
      return false;
    }
      
    var self = this;
    
    if(self.debug)
      console.log(`Starting discovery on ${self.discoveryAddresses.length} addresses...`);
    
    self.discovering = true;
    self.emit('discovering');
    
    // Cycle through our discoveryAddresses array and try to 
    // connect to each potentail peer via WebSocketClient.
    let discoverOne = () => {
      let peerToDiscover = self.discoveryAddresses.splice(0,1)[0];
      
      // next() will be called when we're done discovering on a single
      // address and can move on to the next.
      let next = () => {
        // If we have more addresses in self.discoveryAddresses, keep discovering
        // Else, let's emit the discovered event to show we are done discovering
        if(self.discoveryAddresses.length > 0) discoverOne();
        else self.emit('discovered');
      };
      
      if(self.isConnectedTo(peerToDiscover)) next();
      
      if(self.debug) {
        console.log("------------------------------------------");
        console.log(JSON.stringify(peerToDiscover));
        console.log("------------------------------------------");
      }
      
      // If we have prefix of "::ffff":, strip it (just means its IPv4)
      peerToDiscover.address = peerToDiscover.address.replace(/^::ffff:(.*)$/i, "$1");
      let hasProtocol = /^(.*)\:\/\/(.*)$/i.test(peerToDiscover.address);
      let hasPort = /^(.*)\:[0-9]+$/i.test(peerToDiscover.address);
      
      // The node URL library is very strange... It's string output, when 'format' is
      // called with an object having the 'host' property as the parameter, does not
      // contain the port. So, to work around this, a temporary object is used for
      // parsing, and a url object is made up on the fly with it's 'host' property set 
      // to null in order for the port to be in the string output of 'format()'
      // See https://github.com/nodejs/node/issues/12067 for more details.
      let tmp = url.parse(peerToDiscover.address);
      let hst = "", prt = false;
      
      if(self.debug) {
        console.log(`Discovery Address` + 
          `\n\tProtocol: ${(hasProtocol ? "✔" : "✖")}` +
          `\n\tPort:     ${(hasPort ? "✔" : "✖")}`);
      }
      
      // Have to manually provide logic for port and host mapping to URL library
      // because it is so limited in this regard...
      if(!hasProtocol && hasPort) { // only has port
        hst = tmp.protocol.toString().slice(0,tmp.protocol.toString().length-1);
        prt = parseInt(tmp.hostname || tmp.host);
      } else if(hasProtocol && !hasPort) { // only has protocol
        hst = tmp.hostname || tmp.host || tmp.href;
        prt = null;
      } else if(!hasProtocol && !hasPort) { // has neither
        hst = tmp.href;
        prt = null;
      } else if(hasProtocol && hasPort) { // has both
        hst = tmp.hostname || tmp.host;
        prt = tmp.port || null;
      }
      
      let parsedAddress = {
        'protocol': (hasProtocol ? tmp.protocol : "wss:"),
        'slashes': true,
        'hostname': hst,
        'host': null,
        'port': prt
      };
      
      // If 'parsedAddress' doesn't contain a port and this peer has 
      // a given discovery range, 'self.range', let's expand the address
      // into multiple entries in 'self.discoveryAddresses' for the ports
      // specified in 'self.range'.
      if(!hasPort) {
        // Check if we were provided a range of ports for discovery
        if(self.range && Array.isArray(self.range) && 
          self.range.length == 2 && self.range[0] <= self.range[1]) {
            // Add ports in 'self.range' to the address in question for discovery
            for(let i=self.range[0]; i<=self.range[1]; i++) {
              // Assign the port from the range at index 'i'
              parsedAddress.port = i;
              
              // Create our object (used for testing below)
              let d = { 'address': `${url.format(parsedAddress)}`,
                'signature': peerToDiscover.signature };
              
              let inDiscoveryAddresses = self.inDiscoveryAddresses(d), // not already in queue
                isConnectedTo = self.isConnectedTo(d), // not already connected
                isOwnSignature = self.isOwnSignature(d.signature); // not itself
                
              if(!inDiscoveryAddresses && !isConnectedTo && !isOwnSignature) {
                // If we haven't seen this discovery address before and we aren't
                // already connected to it, push it to our discovery queue
                if(self.debug) console.log(`\t${JSON.stringify(d)}`);
                self.discoveryAddresses.push(d);
              } else {
                if(self.debug) {
                  console.log(`Not connecting to peer ${JSON.stringify(d)}`, 
                    `\n\tinDiscoveryAddresses: ${inDiscoveryAddresses}`,
                    `\n\tisConnectedTo: ${isConnectedTo}`,
                    `\n\tisOwnSignature: ${isOwnSignature}`);
                }
              }
            }
        } else {
          // Add the port we listen on to the address in question for discovery
          parsedAddress.port = self.port;
          
          // Create our object (used for testing below)
          let d = { 'address': `${url.format(parsedAddress)}`,
            'signature': peerToDiscover.signature };
          
          let inDiscoveryAddresses = self.inDiscoveryAddresses(d), // not already in queue
            isConnectedTo = self.isConnectedTo(d), // not already connected
            isOwnSignature = self.isOwnSignature(d.signature); // not itself
            
          if(!inDiscoveryAddresses && !isConnectedTo && !isOwnSignature) {
            // If we haven't seen this discovery address before and we aren't
            // already connected to it, push it to our discovery queue
            if(self.debug) console.log(`\t${JSON.stringify(d)}`);
            self.discoveryAddresses.push(d);
          } else {
            if(self.debug) {
              console.log(`Not connecting to peer ${JSON.stringify(d)}`, 
                `\n\tinDiscoveryAddresses: ${inDiscoveryAddresses}`,
                `\n\tisConnectedTo: ${isConnectedTo}`,
                `\n\tisOwnSignature: ${isOwnSignature}`);
            }
          }
        }
        
        // We weren't given a port for this specific address, so we had to 
        // assign a port/ports, expanding the discovery addresses as a result.
        // As such, we call 'next()' to now discover on those expanded addresses.
        next();
        
        // Since our address was incomplete, return to prevent connecting to it (below)
        return;
      }
      
      if(self.debug)
        console.log(`Discovering on ${url.format(parsedAddress)}`);
      
      let client = new WebSocketClient();
      
      client.on('connectFailed', (error) => {
        if(self.debug)
          console.log('Connect Error: ' + error.toString());
        
        next();
      });
      
      client.on('connect', (connection) => {
        if(self.debug) {
          console.log(`Successfully connected to:\n\t` +
            `Address: ${connection.remoteAddress}\n\t` + 
            `Port: ${connection.socket.remotePort}`);
        }
        
        connection.originalAddress = peerToDiscover.address.slice(0);
        connection.originalPort = parsedAddress.port;
        connection.parsedAddress = url.format(parsedAddress);
        
        // Remove the address from our discoveryAddresses array
        // (We don't want to discover on the address twice...)
        // self.discoveryAddresses.splice(self.discoveryAddresses.indexOf(address),1);
        
        //Set up the connection
        self.setupConnection({ connection });
        
        next();
      });
      
      if(self.debug)
        console.log(`Attempting connection to ${url.format(parsedAddress)}`);
        
      client.connect(url.format(parsedAddress));
    };
    
    if(self.discoveryAddresses.length > 0) discoverOne();
  }
  
  setupConnection({ connection, request=null }) {
    var self = this;
    
    if(self.debug)
      console.log("Peer.setupConnection() invoked");
      
    // We have to have a valid connection to the peer in order to continue
    if(!connection) {
      if(self.debug) {
        console.error("Peer.setupConnection: connection is null or undefined!");
      }
      return false;
    }
    
    // Some initial variables...
    let created = new Date(new Date().toUTCString()),
      active = created;
    
    // We CANNOT trust the connection until after the HELO handshake takes place
    // and we are able to verify the connection's (peer's) public key via a 'trusted'
    // message exchange. Until the said is complete, the connection cannot and will not
    // be trusted and no other messages will be sent/received other than 'helo'.
    connection.trusted = false;
    
    connection.connected = true;
    
    connection.unconfirmedMessages = [];
    connection.requireConfirmation = false;
    
    if(!connection.hasOwnProperty("originalAddress")) {
      if(request && request.hasOwnProperty("httpRequest") && 
        request.httpRequest.hasOwnProperty("headers") &&
        request.httpRequest.headers.hasOwnProperty("x-forwarded-for")) {
          connection.originalAddress = request.httpRequest.headers['x-forwarded-for'];
        
          if(self.debug) {
            console.log(`Address parsed from request.httpRequest.headers['x-forwarded-for']: ` +
              `${connection.originalAddress}`);
          }
      } else if(request && request.hasOwnProperty("connection") && 
        request.connection.hasOwnProperty("remoteAddress")) {
          connection.originalAddress = request.connection.remoteAddress;
          
          if(self.debug) {
            console.log(`Address parsed from request.connection.remoteAddress: ` +
              `${connection.originalAddress}`);
          }
      } else {
        connection.originalAddress = 
          connection.remoteAddress.slice(0).replace(/^::ffff:(.*)$/i, "$1");
      
        if(self.debug) {
          console.log(`Address parsed from connection: ${connection.originalAddress}`);
        }
      }
    }
    
    if(!connection.hasOwnProperty("originalPort")) {
      connection.originalPort = connection.socket.remotePort;
    }
      
    // Add the connection to our list of peers
    self.peers.push({ request, connection, created, active });
    
    // Set up our message receiver event handler for every connection
    connection.on('message', (message) => {
      if(message.type === 'utf8') {
        // Process the WebSocket message via seld.receive
        self.receive({ connection, 'message': message.utf8Data });
      }
    });
    
    // Set up our error event handler for every connection
    connection.on('error', (err) => {
      connection.trusted = false;
      connection.active = new Date(new Date().toUTCString());
      
      if(self.debug) {
        console.error("Connection Error: " + err.toString());
        console.error(JSON.stringify(err));
        console.error(err.stack);
      }
    });
    
    // Set up our connection close event handler for every connection
    connection.on('close', function(code, description) {
      connection.trusted = false;
      connection.active = new Date(new Date().toUTCString());
      
      if(self.debug)
        console.log(`Connection closed: ${code} - ${description}`);
    			
      if(code !== 1000) { // Abnormal close
  	    self.discoveryAddresses.push({
          'address': this.originalAddress,
          'signature': this.peerPublicKeySignature.toString('base64')
        });
        
        // On an abnormal close, we should try to discover in order
        // to reattempt connection with the peer we lost
        if(!self.discovering) {
          setTimeout(() => {
            self.discover.apply(self,null);
          }, 60000);
        }
    	}
    });
    
    if(self.debug)
      console.log("Peer.setupConnection: sending HELO to connection...");
    
    // Now it's time to perform the HELO handshake to the Connection
    // NOTE: this handshake happens BOTH ways - e.g. a HELO is responded
    // to by a HELO of our own, making the handshake in total.
    try {
      // Send HELO
      var helo = new PeerMessage();
      
      helo.body = {
        // We have to send our public key and public key signature (signed
        // by the ring.pem) to the connection (peer) for validation. The peer
        // will do the same for us, so we can establish trust with one another.
        'publicKey': self.publicKey.exportKey("public"),
        'signature': self.signature.toString('base64')
      };
      
      var heloCallback = function(err) {
        if(err) { // If at first we don't succeed ...
          setTimeout(function() {
            // ... try, try again
            connection.sendUTF(helo.toString(), heloCallback);
          }, 5000);
        }
      };
      
      //Send the message
      connection.sendUTF(helo.toString(), heloCallback);
    } catch(e) {
      // In case of error, log the stack. Most likely, if we're here, it is
      // the result of an export error in NodeRSA (above) or a message send
      // error (connection.sendUTF).
      console.error(e.stack);
    }
  }
  
  receive({ connection, message }) {
    if(message) {
      // Convert the message to a PeerMessage class object
      message = new PeerMessage({ message });
    } else {
      // If we weren't supplied a message, let's simply return false.
      return false;
    }
    
    // Convert the header 'type' property from a number into a human-readable string
    let headerTypeString = PeerMessage.PEER_MESSAGE_STRING(message.header.type);
    
    if(this.debug) {
      console.log(`Incoming message '${headerTypeString}' from `+
        `${connection.remoteAddress} - ${connection.originalAddress} ` +
        `on port ${connection.originalPort}`);
    }
    
    // Cycle through our list of peers and find the peer that this message is coming from.
    // Once found, update the 'active' property to the current time (in ms) to reflect when
    // the last message was received from the peer.
    for(let p of this.peers) {
      if(connection.hasOwnProperty("originalAddress") && p.connection.hasOwnProperty("originalAddress")) {
        if(JSON.stringify(connection.originalAddress) == JSON.stringify(p.connection.originalAddress)) {
          if(this.debug)
            console.log("Updating peer 'active' time to current timestamp (in ms).");
            
          p.active = new Date(new Date().toUTCString());
          break;
        }
      }
    }
    
    if(message.header.type == PeerMessage.PEER_MESSAGE_TYPES.helo) {
      // Check that the signature and public key the peer gave us
      // were indeed signed by the same private key that 'this' publicKey
      // was signed with (aka the ring private)...
      var peerPublicKey = false,
        peerPublicKeySignature = false,
        keyIsSigned = false;
      
      try {
        // Generate the NodeRSA key and peerPublicKeySignature from that which 
        // the message (from peer) have provided in it's body.
        peerPublicKey  = new NodeRSA(message.body.publicKey);
        peerPublicKeySignature = new Buffer(message.body.signature, 'base64');
        
        // Check to make sure the signature isn't our own. If so, we don't want
        // to connect to ourselves, obviously.
        if(this.isOwnSignature(peerPublicKeySignature.toString("base64"))) {
          if(this.debug) 
            console.log("Received signature matching own signature from peer.",
              "Closing connection so as to prevent potential connection to self.");
          connection.close();
          return;
        }
        
        if(this.debug) {
          console.log("\tGot peer public key...");
          console.log("\t\t-> Signature (last 50 bytes): " + peerPublicKeySignature.slice(-50).toString("base64"));
        }
        
        // Verify the peer's public key...
        keyIsSigned = this.ringPublicKey.verify(message.body.publicKey, peerPublicKeySignature);
        
        if(this.debug) {
          console.log(`\tkeyIsSigned: ${keyIsSigned}`);
        }
      } catch(e) {
        // If we've landed here, it is most likely the result of an error creating 
        // the NodeRSA key from the key in the given peer's message body OR there was
        // an error as a result of calling ringPublicKey.verify.
        console.error("ERROR: The peer's message body could either not be understood " +
          "or not be verified. Exiting now.");
          
        return false;
      }
      
      // Let's check to make sure we have the peerPublicKey, peerPublicKeySignature, and 
      // the signature has been VERIFIED against our copy of ringPublicKey
      if(peerPublicKey && peerPublicKeySignature && keyIsSigned) {
          if(this.debug) {
            console.log(`\tPeer at ${connection.remoteAddress} on port ` +
              `${connection.socket.remotePort} is now TRUSTED.`);
          }
          
          // Set the trusted flag on the connection, and set some other connection variables
          // for use in later communications (AES-256-CBC).
          connection.trusted = true;
          connection.peerPublicKey = peerPublicKey;
          connection.peerPublicKeySignature = peerPublicKeySignature;
          connection.iv = new Buffer(crypto.randomBytes(16));
          connection.key = new Buffer(crypto.randomBytes(32));
          
          // Encrypt the key and iv with the peer's public key which we have as a result of 
          // the (now verified and trusted) HELO
          let encryptedIV = peerPublicKey.encrypt(connection.iv);
          let encryptedKey = peerPublicKey.encrypt(connection.key);
          
          // Create and send a verification of trust message
          let knownPeers = this.getPeerList([ peerPublicKeySignature.toString('base64') ]);
          
          if(this.debug) console.log(JSON.stringify(knownPeers));
          
          let trusted = new PeerMessage();
          trusted.header.type = PeerMessage.PEER_MESSAGE_TYPES.trusted;
          trusted.body = {
            'key': encryptedKey.toString('base64'),
            'iv': encryptedIV.toString('base64'),
            'peers': knownPeers,
            'listening': {
              'port': this.port,
              'address': this.publicAddress,
            },
            'requireConfirmation': this.requireConfirmation
          };
          trusted.header.signature = this.privateKey.sign(JSON.stringify(trusted.body));
          
          var trustedCallback = function(err) {
            if(err) {
              setTimeout(function() {
                connection.sendUTF(trusted.toString(), trustedCallback);
              }, 5000);
            }
          };
          
          // Send the message
          connection.sendUTF(trusted.toString(), trustedCallback);
      }
    } else if(connection.trusted) {
      // The connection has been trusted prior to be past this point (post-HELO)
      
      // Check to see if we're receiving a verification of trust message (trusted)
      if(message.header.type == PeerMessage.PEER_MESSAGE_TYPES.trusted) {
        // If so, the message needs to have both iv and key properties in order to 
        // upgrade the connection's message encryption scheme to AES-256-CBC as opposed
        // to the RSA encryption used in the handshake.
        if(message.body.hasOwnProperty("iv") && message.body.hasOwnProperty("key")) {
          // We need to try to take the key and iv the peer has given us and decrypt them
          // using our private key (since they were encrypted using our public key post-HELO)
          try {
            connection.peerIv = this.privateKey.decrypt(Buffer.from(message.body.iv, 'base64'));
            connection.peerKey = this.privateKey.decrypt(Buffer.from(message.body.key, 'base64'));
            
            this.emit('connection', { connection });
          } catch(e) {
            if(this.debug) {
              console.error("ERROR: 'trusted' message received but our private key " +
                "could not decrypt its contents. Exiting now.");
            }
                
            // TODO: Should we add this peer back to discoveryAddresses then? Try again?
            return false;
          }
          
          if(message.body.hasOwnProperty("requireConfirmation") && 
            typeof message.body.requireConfirmation == "boolean") {
              if(this.debug) {
                console.log(`Peer at ${connection.remoteAddress} - ` +
                  `${connection.originalAddress} on port ${connection.socket.remotePort} ` +
                  `${(message.body.requireConfirmation ? "is" : "is NOT")}` + 
                  ` requesting message confirmation.`);
              }
                
              connection.requireConfirmation = message.body.requireConfirmation;    
          }
          
          if(message.body.hasOwnProperty("listening") && typeof message.body.listening == "object") {
            if(message.body.listening.hasOwnProperty("address")) {
              if(this.debug) {
                console.log(`Peer reports it is listening on address ${message.body.listening.address}; ` +
                  `Peer \`originalAddress\` attribute will be updated to reflect so.`);
              }
              
              connection.originalAddress = message.body.listening.address;
            }
            
            if(message.body.listening.hasOwnProperty("port")) {
              let toParse = message.body.listening.port;
              
              if(typeof message.body.listening.port !== "number") {
                try {
                  toParse = parseInt(toParse);
                } catch(e) {
                  toParse = message.body.listening.port;
                }
              }
              
              if(this.debug) {
                console.log(`Peer reports it is listening on port ${toParse}; ` +
                  `Peer \`originalPort\` attribute will be updated to reflect so.`);
              }
              
              connection.originalPort = toParse;
            }
          }
          
          // Check to see if the verification of trust (trusted) message contains a list
          // of known peers to this peer. This is done for discovery.
          if(message.body.hasOwnProperty("peers") && Array.isArray(message.body.peers)) {
            // Create a variable to compare to the length of discoveryAddresses later
            let lengthBefore = this.discoveryAddresses.length;
            
            for(let i=0; i<message.body.peers.length; i++) {
              // Check for leading '::ffff:', if so, we have IPv4 address and can strip it
              if(message.body.peers[i].address.indexOf("::ffff:") === 0)
                message.body.peers[i].address = message.body.peers[i].address.slice(7);
              
              // If we haven't seen a peer in the list of peers that this peer has given
              // us (wow, what a mouthful!), then add it to our discoveryAddresses array
              // for discovery at a later time
              if(!this.inDiscoveryAddresses(message.body.peers[i]) && // not already in queue
                !this.isConnectedTo(message.body.peers[i]) && // not already connected
                !this.isOwnSignature(message.body.peers[i].signature)) { // not itself
                  if(this.debug) {
                    console.log(`Peer gave new unknown peer to discover: ` +
                      `${JSON.stringify(message.body.peers[i])}`);
                  }
                  
                  this.discoveryAddresses.push(message.body.peers[i]);
              }
            }
            
            // Check if we've added any addresses to discover
            if(this.discoveryAddresses.length > lengthBefore) {
              this.discover();
            }
          }
        } else {
          if(this.debug)
              console.error("ERROR: 'trusted' message received but message body " +
                "does not contain correct content. Exiting now.");
                
          // TODO: Should we add this peer back to discoveryAddresses then? Try again?
          return false;
        }
        
      } else if(message.header.type == PeerMessage.PEER_MESSAGE_TYPES.confirm) {
        if(!this.requireConfirmation) return;
        
        if(this.debug)
          console.log("Received message confirmation from peer");
        
        // Receive confirmation that peer has received a message prior sent
        if(message.hasOwnProperty("header") && 
          message.header.hasOwnProperty("confirm") &&
          typeof message.header.confirm == "object" &&
          message.header.confirm.hasOwnProperty("hash") &&
          typeof message.header.confirm.hash == "string" && 
          message.header.confirm.hasOwnProperty("timestamp") &&
          typeof message.header.confirm.timestamp == "string") {
            
            if(this.debug) {
              console.log(`\tPeer would like to confirm receipt of message [` +
                `${message.header.confirm.hash}/${message.header.confirm.timestamp}]`);
            }
              
            // Let's try to find the matching message (by hash)
            for(let i=connection.unconfirmedMessages.length-1; i>=0; i--) {
              // Check our 'unconfirmedMessages' hashes against 'confirm' message header hash
              if(connection.unconfirmedMessages[i].header.hash == message.header.confirm.hash
                && connection.unconfirmedMessages[i].header.timestamp.toISOString() == 
                message.header.confirm.timestamp) {
                  // We have a match, confirm the message's receipt by removing it from 
                  // 'unconfirmedMessages' array.
                  connection.unconfirmedMessages.splice(i,1);
                  
                  if(this.debug)
                    console.log(`\tMessage [${message.header.confirm.hash}/` +
                      `${message.header.confirm.timestamp}] has been confirmed.`);
                    
                  break;
              }
            }
        }
      } else if (message.header.type == PeerMessage.PEER_MESSAGE_TYPES.peers) {
        // Create and send a verification of trust message
        let peers = new PeerMessage();
        peers.header.type = PeerMessage.PEER_MESSAGE_TYPES.peers;
        peers.body = { 'peers': this.getPeerList() };
        peers.header.signature = this.privateKey.sign(JSON.stringify(peers.body));
        
        // Send the message
        connection.sendUTF(peers.toString(), function(err) { /* Do nothing. */ });
      } else {
        // Do some sort of 'update' here BUT only if 
        // we haven't already processed the same UPDATE
        // from another peer in the network.
        
        //if(message.header.hash == LAST UPDATE HASH)
        try {
          // Create an AES-256-CBC decipher to decrypt the message body
          let encryptedMessageBody = Buffer.from(message.body,'base64');
          let messageSignature = Buffer.from(message.header.signature, 'base64');
          
          if(this.debug) {
            console.log(`Message Signature: ${messageSignature.toString('base64')}`);
            console.log(`Encrypted Message Body: ${encryptedMessageBody.toString('base64')}`);  
          }
          
          let decipher = crypto.createDecipheriv('aes-256-cbc', connection.peerKey, connection.peerIv);
          let decryptedMessageBody = (Buffer.concat([decipher.update(encryptedMessageBody), 
            decipher.final()]));
          
          // Check the message's 'signature' header...
          if(connection.peerPublicKey.verify(decryptedMessageBody, messageSignature)) {
            // Parse the decrypted message body back to JSON now (remember, 
            // before encryption by peer it was originally a JavaScript object).
            // The try/catch blocks around this scope allow for graceful failure
            // if the JSON.parse throws an exception.
            message.body = JSON.parse(decryptedMessageBody.toString('utf8'));
            
            if(connection.requireConfirmation) {
              // Send confirmation back to peer that we have received the message
              let confirmationMsg = new PeerMessage({
                type: PeerMessage.PEER_MESSAGE_TYPES.confirm
              });
              
              confirmationMsg.header.confirm = {
                'hash': message.header.hash,
                'timestamp': message.header.timestamp
              };
              
              this.broadcast({
                message: confirmationMsg,
                connection
              });
            }
            
            // Emit the message event so our instantiator can take action
            this.emit('message', { message, connection });
            
            if(typeof message.header.type == "string") {
              let type = PeerMessage.PEER_MESSAGE_STRING(message.header.type);
              
              if(this.debug)
                console.log(`Emitting custom event: '${type}''.`);
              
              this.emit(type, { message, connection });
            }
          } else {
            // Signature didn't match, throw error to exit
            throw new Error("ERROR: Message decrypted, but signature could not be verified.");
          }
        } catch(e) {
          if(this.debug) {
            // We're probably here as a result of a decrpytion error or verification error, in 
            // which case the message may have been corrupted. Best to exit gracefully...
            console.error("ERROR: trusted message was received but either could not be decrypted " +
              "with the agreed-upon AES properties or could not be verified using the established " +
              "RSA keys and given message signature.");
              
            console.log(JSON.stringify(message, true));
            console.log(e.stack);
          }
        }
      }
    }
  }

  broadcast(options) {
    let msg = false;
    
    if(options instanceof PeerMessage) {
      // Support for `peer.broadcast(<PeerMessage>);`
      msg = options;
    } else if(typeof options == "string") {
      // Support for `peer.broadcast(<string>);`
      msg = new PeerMessage({
        type: PeerMessage.PEER_MESSAGE_TYPES.message,
        body: options
      });  
    }
    
    let { message=msg, connection=false } = options || {};
    
    if(this.debug) console.log(`Peer.broadcast invoked.`);
      
    // If there are no peers to broadcast to, exit
    if(this.peers.length < 1) {
      if(this.debug)
        console.error("ERROR: No peers to broadcast message to. Exiting.");
      return false;
    }
    
    // If there is no message to broadcast, exit
    if(!message || typeof message == 'undefined') {
      if(this.debug)
        console.error("ERROR: No message to broadcast or incorrect message type. Exiting.");
      return false;
    }
    
    if(this.debug)
      console.log(`Broadcasting ${message} to ${this.peers.length} peers...`);
    
    // If the message is not a string and is not an instance of PeerMessage ...
    if(typeof message !== "string" && 
      !(message instanceof PeerMessage)) {
        // ... stringify it
        try {
          message = JSON.stringify({ message });
        } catch(e) {
          console.error("Unknown message or circular dependency when calling JSON.stringify.");
          return false;
        }
    }
    
    // If we weren't given a specific connection, send to all peers
    var toSendTo = !connection ? this.peers : [{ connection }];
    
    // Broadcast a message to all connected peers
    for(let p of toSendTo) {
      if(p.connection.connected) {
        if(p.connection.trusted) {
          // We need to encrypt the message with the connection's AES properties
          let messageCopyToSend = new PeerMessage({ message });
          
          /*
            If the 'requireConfirmation' flag is set on this peer, then we need to
            check back at a scheduled timeout as to whether the message has been
            received by the peers we sent the message to.
          */
          if(this.requireConfirmation && 
            messageCopyToSend.header.type !== PeerMessage.PEER_MESSAGE_TYPES.confirm) {
              /*
                Wrap in anonymous function in order to preserve scope (pass in peer and msg -- 
                the 'timeout' function occurs much later than when 'broadcast' is called, but we
                still need to access the peer and the message in question)
              */
              (function(self, peer, msg) {
                setTimeout(function() {
                  let found = false;
                  
                  for(let i=0; i<peer.connection.unconfirmedMessages.length; i++) {
                    // Look to match the message in question to those in 'unconfirmedMessages'
                    if(peer.connection.unconfirmedMessages[i].header.hash == msg.header.hash
                      && peer.connection.unconfirmedMessages[i].header.timestamp.toString() == msg.header.timestamp) {
                        found = true;
                        break;
                    }
                  }
                  
                  // Message hasn't been confirmd by peer yet, try sending again...
                  if(found) {
                    self.broadcast(msg);
                  } else if(self.debug) {
                    console.info(`\tMessage [${msg.header.hash}/${msg.header.timestamp.toISOString()}] ` +
                      `already confirmed, will not be resent.`);
                  }
                }, 30000);
              })(this, p, messageCopyToSend);
          }
          
          p.connection.unconfirmedMessages.push(message);
          
          try {
            // Write the signature (signed by OUR RSA private) to the message's header
            messageCopyToSend.header.signature = 
              (this.privateKey.sign(JSON.stringify(messageCopyToSend.body))).toString('base64');
            
            // Encrypt the message body with the connection's aes-256-cbc properties
            let cipher = crypto.createCipheriv('aes-256-cbc', p.connection.key, p.connection.iv);
            let messageBodyBuffer = new Buffer(JSON.stringify(messageCopyToSend.body));
            messageCopyToSend.body = Buffer.concat([cipher.update(messageBodyBuffer), cipher.final()]).toString('base64');
            
            var sendCallback = function(err) {
              if(err) {
                if(this.debug)
                  console.error("ERROR: broadcasting message failed. Message will try to resend soon.");
                
                this.broadcast(messageCopyToSend);
              }
            };
            
            var self = this;
            p.connection.sendUTF(JSON.stringify(messageCopyToSend), (err) => sendCallback.apply(self, err));
          } catch(e) {
            // Something went wrong with the encryption, most likely, so let's
            // gracefully fail and exit...
            if(this.debug) {
              console.error("ERROR: broadcast to TRUSTED connection failed. This could be " +
                "and more likely is due to an encryption error. Exiting now.");
              console.error(e.stack);
            }
          }
        } else {
          // If we do not have a trusted connection, but we are trying to establish one
          // via a HELO handshake, let the message be sent
          if(message.header.type == PeerMessage.PEER_MESSAGE_TYPES.helo) {
            var heloCallback = function(err) {
              if(err) {
                setTimeout(function() {
                  connection.sendUTF(message, heloCallback);
                }, 5000);
              }  
            };
            
            p.connection.sendUTF(message, heloCallback);
          } else if(this.debug) {
            console.error("ERROR: broadcast invoked with sensitive message () but " +
              "the connection is not trusted; not sending message.");
          }
        }
      } else { // p.connection.connected == FALSE
        if(this.debug) {
          console.error(`ERROR: broadcast attempted to ${p.connection.originalAddress} but ` +
            `the connection is closed!`);
        }
      }
    }
    
    // For chaining
    return this;
  }
  
  close() {
    this.ready = false;
    
    for(let p of this.peers) {
      try {
        p.connection.close();
      } catch(e) {
        if(this.debug)
          console.error(e.stack);
      }
    }
    
    this.httpsServer.close();
    
    return this;
  }
  
  isOwnSignature(s) {
    if(!s) return false;
    if(typeof s !== "string") s = s.toString("base64");
    return s == this.signature.toString("base64");
  }
  
  inDiscoveryAddresses(peer) {
    let str = JSON.stringify(peer);
    for(let i=0; i<this.discoveryAddresses.length; i++) {
      // if(this.discoveryAddresses[i].hasOwnProperty("address") &&
      //   this.discoveryAddresses[i].hasOwnProperty("signature") &&
      //   this.discoveryAddresses[i].address &&
      //   this.discoveryAddresses[i].signature &&
      //   this.discoveryAddresses[i].address.toString() == address.toString() && 
      //   this.discoveryAddresses[i].signature.toString('base64') == signature.toString()) {
      //     return true;
      // }
      if(JSON.stringify(this.discoveryAddresses[i]) == str) {
        return true;
      }
    }
    
    return false;
  }
  
  isConnectedTo({ address, signature }) {
    // Check first to make sure we aren't trying to connect to ourself...
    if(this.signature.toString('base64') == signature) return true;
    
    for(let i=0; i<this.peers.length; i++) {
      // Check if we're connected to the peer before checking if the peer is
      // the same as the one given. If all the above, return true right away
      if(this.peers[i].connection.hasOwnProperty("peerPublicKeySignature") &&
        this.peers[i].connection.peerPublicKeySignature.toString('base64') == signature) {
          return true;
      }
    }
    
    // We've only reached here as a result of not finding an active connection
    // the same as the one we're given
    return false;
  }
  
  getPeerList(signaturesToOmit) {
    let peerList = [];
    
    if(!signaturesToOmit || !Array.isArray(signaturesToOmit))
      signaturesToOmit = [];
    
    // Add list of our known peers to the body, so that, when
    // received by the other peer, it can discover those addresses
    // as well, creating a fully connected, bidirectional graph (network).
    for(let i=0; i<this.peers.length; i++) {
      if(this.peers[i].connection.hasOwnProperty("peerPublicKeySignature") && 
        this.peers[i].connection.hasOwnProperty("originalAddress")) {
          let peerPublicKeySignatureBase64 = 
            this.peers[i].connection.peerPublicKeySignature.toString('base64');
            
          if(signaturesToOmit.indexOf(peerPublicKeySignatureBase64) < 0) {
            peerList.push({
              'address': `${this.peers[i].connection.originalAddress
                .slice(0).replace(/^::ffff:(.*)$/i, "$1")}` + 
                (
                  this.peers[i].connection.originalAddress.indexOf(":") > -1 ? 
                  `` : `:${this.peers[i].connection.originalPort}`
                ),
              // 'remoteAddress': this.peers[i].connection.remoteAddress,
              'signature': peerPublicKeySignatureBase64,
              'created': this.peers[i].created,
              'active': this.peers[i].active,
              'trusted': this.peers[i].connection.trusted
            });
          }
      }
    }
    
    return peerList;
  }
  
  toString() {
    return JSON.stringify({
      'port': this.port,
      'credentials': {
        'key': this.httpsKeyLocation,
        'cert': this.httpsCertLocation
      },
      'ringPublicKey': this.ringPublicKeyLocation,
      'publicKey': this.publicKeyLocation,
      'privateKey': this.privateKeyLocation,
      'signature': this.signatureLocation,
      'discoveryAddresses': this.discoveryAddresses.concat(this.getPeerList()),
      'discoveryRange': this.range,
      'startDiscovery': this.startDiscovery,
      'requireConfirmation': this.requireConfirmation,
      'debug': this.debug
    });
  }
  
};