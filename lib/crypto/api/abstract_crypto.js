/* Abstract class. Instantiate an instance of either SFCryptoJS (uses cryptojs) or SFCryptoWeb (uses web crypto) */

class SFAbstractCrypto {

  generateRandomKey(bits) {
    return CryptoJS.lib.WordArray.random(bits/8).toString();
  }

  generateUUID() {
    var crypto = window.crypto || window.msCrypto;
    if(crypto) {
      var buf = new Uint32Array(4);
      crypto.getRandomValues(buf);
      var idx = -1;
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          idx++;
          var r = (buf[idx>>3] >> ((idx%8)*4))&15;
          var v = c == 'x' ? r : (r&0x3|0x8);
          return v.toString(16);
      });
    } else {
      var d = new Date().getTime();
      if(window.performance && typeof window.performance.now === "function"){
        d += performance.now(); //use high-precision timer if available
      }
      var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = (d + Math.random()*16)%16 | 0;
        d = Math.floor(d/16);
        return (c=='x' ? r : (r&0x3|0x8)).toString(16);
      });
      return uuid;
    }
  }

  decryptText({ciphertextToAuth, contentCiphertext, encryptionKey, iv, authHash, authKey} = {}, requiresAuth) {
    if(requiresAuth && !authHash) {
      console.error("Auth hash is required.");
      return;
    }

    if(authHash) {
      var localAuthHash = SFJS.crypto.hmac256(ciphertextToAuth, authKey);
      if(authHash !== localAuthHash) {
        console.error("Auth hash does not match, returning null.");
        return null;
      }
    }
    var keyData = CryptoJS.enc.Hex.parse(encryptionKey);
    var ivData  = CryptoJS.enc.Hex.parse(iv || "");
    var decrypted = CryptoJS.AES.decrypt(contentCiphertext, keyData, { iv: ivData,  mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    return decrypted.toString(CryptoJS.enc.Utf8);
  }

  encryptText(text, key, iv) {
    var keyData = CryptoJS.enc.Hex.parse(key);
    var ivData  = CryptoJS.enc.Hex.parse(iv || "");
    var encrypted = CryptoJS.AES.encrypt(text, keyData, { iv: ivData,  mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    return encrypted.toString();
  }

  generateRandomEncryptionKey() {
    var salt = SFJS.crypto.generateRandomKey(512);
    var passphrase = SFJS.crypto.generateRandomKey(512);
    return CryptoJS.PBKDF2(passphrase, salt, { keySize: 512/32 }).toString();
  }

  firstHalfOfKey(key) {
    return key.substring(0, key.length/2);
  }

  secondHalfOfKey(key) {
    return key.substring(key.length/2, key.length);
  }

  base64(text) {
    return window.btoa(text);
  }

  base64Decode(base64String) {
    return window.atob(base64String);
  }

  sha256(text) {
    return CryptoJS.SHA256(text).toString();
  }

  hmac256(message, key) {
    var keyData = CryptoJS.enc.Hex.parse(key);
    var messageData = CryptoJS.enc.Utf8.parse(message);
    var result = CryptoJS.HmacSHA256(messageData, keyData).toString();
    return result;
  }

  supportsPasswordDerivationCost(cost) {
    // some passwords are created on platforms with stronger pbkdf2 capabilities, like iOS,
    // which CryptoJS can't handle here (WebCrypto can however).
    // if user has high password cost and is using browser that doesn't support WebCrypto,
    // we want to tell them that they can't login with this browser.
    if(cost > 5000) {
      return this instanceof SFCryptoWeb;
    } else {
      return true;
    }
  }

  computeEncryptionKeysForUser({password, pw_salt, pw_cost} = {}, callback) {
     this.generateSymmetricKeyPair({password: password, pw_salt: pw_salt, pw_cost: pw_cost}, function(keys){
         callback({pw: keys[0], mk: keys[1], ak: keys[2]});
       }.bind(this));
   }

  generateInitialEncryptionKeysForUser({email, password} = {}, callback) {
    var pw_cost = this.defaultPasswordGenerationCost();
    var pw_nonce = this.generateRandomKey(512);
    var pw_salt = this.sha256([email, pw_nonce].join(":"));
    this.generateSymmetricKeyPair({email: email, password: password, pw_salt: pw_salt, pw_cost: pw_cost}, function(keys){
      callback({pw: keys[0], mk: keys[1], ak: keys[2]}, {pw_salt: pw_salt, pw_cost: pw_cost});
    }.bind(this));
  }

}

export { SFAbstractCrypto }
