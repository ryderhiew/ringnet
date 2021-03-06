"use strict";
const test = require('tape');

const { Peer, PeerMessage, PeerMessageQueue, Expectation } 
  = require('../index.js');

// ----------------------------------------------------------------------------------
// ----------------------------------------------------------------------------------
// ----------------------------------------------------------------------------------
// ----------------------------------------------------------------------------------

test("PeerCustomEventListener", (assert) => {
  let peer1 = new Peer({
    'port': 26784,
    'publicAddress': '127.0.0.1',
    'signature': "first.peer.signature",
    'publicKey': "first.peer.pub",
    'privateKey': "first.peer.pem",
    'ringPublicKey': ".ring.pub",
    'debug': false
  });
  
  peer1.on('connection', ({ connection }) => {
    peer1.broadcast(new PeerMessage({
      type: "Cu570m_M3554g3",
      body: "Hey, let's test this custom event listener!"
    }));
  });
  
  peer1.on('ready', () => {
    let peer2 = new Peer({
      'port': 26785,
      'discoveryAddresses': [ "127.0.0.1:26784" ],
      'publicAddress': '127.0.0.1',
      'signature': "second.peer.signature",
      'publicKey': "second.peer.pub",
      'privateKey': "second.peer.pem",
      'ringPublicKey': ".ring.pub",
      'debug': false
    });
    
    peer2.on('Cu570m_M3554g3', ({ message, connection }) => {
      assert.equal(message.body, "Hey, let's test this custom event listener!", 
        'Message with custom PeerMessage header type should be received by custom ' +
        'event listener.');
      assert.ok(true, `Custom event listener fired; test passed.`);
      
      peer1.close();
      peer2.close();
      
      assert.end();
    });
  });
});

