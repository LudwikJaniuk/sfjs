export class SFSyncManager {

  constructor(modelManager, storageManager, httpManager, timeout, interval) {

    this.httpManager = httpManager;
    this.modelManager = modelManager;
    this.storageManager = storageManager;

    // Allows you to et your own interval/timeout function (i.e if you're using angular and want to use $timeout)
    this.$interval = interval || setInterval.bind(window);
    this.$timeout = timeout || setTimeout.bind(window);

    this.syncStatus = {};
    this.syncStatusObservers = [];
  }

  async getServerURL() {
    return await this.storageManager.getItem("server") || window._default_sf_server;
  }

  registerSyncStatusObserver(callback) {
    var observer = {key: new Date(), callback: callback};
    this.syncStatusObservers.push(observer);
    return observer;
  }

  removeSyncStatusObserver(observer) {
    _.pull(this.syncStatusObservers, observer);
  }

  syncStatusDidChange() {
    this.syncStatusObservers.forEach((observer) => {
      observer.callback(this.syncStatus);
    })
  }

  setEventHandler(handler) {
    /*
    Possible Events:
    sync:completed
    sync:taking-too-long
    sync:updated_token
    sync:error
    major-data-change
     */
    this.eventHandler = handler;
  }

  notifyEvent(syncEvent, data) {
    this.eventHandler(syncEvent, data);
  }

  setKeyRequestHandler(handler) {
    this.keyRequestHandler = handler;
  }

  async getActiveKeyInfo() {
    // keyRequestHandler is set externally by using class. It should return an object of this format:
    /*
    {
      keys: {pw, mk, ak}
      version,
      offline: true/false
    }
    */
    return this.keyRequestHandler();
  }

  async loadLocalItems(callback) {
    this.storageManager.getAllModels.then((items) => {
      // break it up into chunks to make interface more responsive for large item counts
      let total = items.length;
      let iteration = 50;
      var current = 0;
      var processed = [];

      var completion = () => {
        SFItem.sortItemsByDate(processed);
        callback(processed);
      }

      var decryptNext = async () => {
        var subitems = items.slice(current, current + iteration);
        var processedSubitems = await this.handleItemsResponse(subitems, null, SFModelManager.MappingSourceLocalRetrieved);
        processed.push(processedSubitems);

        current += subitems.length;

        if(current < total) {
          this.$timeout(() => { decryptNext(); });
        } else {
          completion();
        }
      }

      decryptNext();
    })
  }

  async writeItemsToLocalStorage(items, offlineOnly) {
    return new Promise(async (resolve, reject) => {
      if(items.length == 0) {
        resolve();
        return;
      }

      let info = await this.getActiveKeyInfo();

      Promise.all(items.map(async (item) => {
        var itemParams = new SFItemParams(item, info.keys, info.version);
        itemParams = await itemParams.paramsForLocalStorage();
        if(offlineOnly) {
          delete itemParams.dirty;
        }
        return itemParams;
      })).then((params) => {
        this.storageManager.saveModels(params).then(() => {
          // on success
          if(this.syncStatus.localError) {
            this.syncStatus.localError = null;
            this.syncStatusDidChange();
          }
          resolve();
        }).catch((error) => {
          // on error
          console.log("Error writing items", error);
          this.syncStatus.localError = error;
          this.syncStatusDidChange();
          reject();
        });
      })
    })
  }

  async syncOffline(items, callback) {
    // Update all items updated_at to now
    for(var item of items) { item.updated_at = new Date(); }
    this.writeItemsToLocalStorage(items, true).then((responseItems) => {
      // delete anything needing to be deleted
      for(var item of items) {
        if(item.deleted) { this.modelManager.removeItemLocally(item);}
      }

      this.notifyEvent("sync:completed");
      // Required in order for modelManager to notify sync observers
      this.modelManager.didSyncModelsOffline(items);
      callback && callback({success: true});
    })
  }

  /*
    In the case of signing in and merging local data, we alternative UUIDs
    to avoid overwriting data a user may retrieve that has the same UUID.
    Alternating here forces us to to create duplicates of the items instead.
   */
  markAllItemsDirtyAndSaveOffline(callback, alternateUUIDs) {

    // use a copy, as alternating uuid will affect array
    var originalItems = this.modelManager.allItems.filter((item) => {return !item.errorDecrypting}).slice();

    var block = () => {
      var allItems = this.modelManager.allItems;
      for(var item of allItems) {
        item.setDirty(true);
      }
      this.writeItemsToLocalStorage(allItems, false).then(callback);
    }

    if(alternateUUIDs) {
      var index = 0;

      let alternateNextItem = () => {
        if(index >= originalItems.length) {
          // We don't use originalItems as alternating UUID will have deleted them.
          block();
          return;
        }

        var item = originalItems[index];
        index++;

        // alternateUUIDForItem last param is a boolean that controls whether the original item
        // should be removed locally after new item is created. We set this to true, since during sign in,
        // all item ids are alternated, and we only want one final copy of the entire data set.
        // Passing false can be desired sometimes, when for example the app has signed out the user,
        // but for some reason retained their data (This happens in Firefox when using private mode).
        // In this case, we should pass false so that both copies are kept. However, it's difficult to
        // detect when the app has entered this state. We will just use true to remove original items for now.
        this.modelManager.alternateUUIDForItem(item, alternateNextItem, true);
      }

      alternateNextItem();
    } else {
      block();
    }
  }

  async getSyncURL() {
    return await this.getServerURL() + "/items/sync";
  }

  async setSyncToken(token) {
    this._syncToken = token;
    await this.storageManager.setItem("syncToken", token);
  }

  async getSyncToken() {
    if(!this._syncToken) {
      this._syncToken = await this.storageManager.getItem("syncToken");
    }
    return this._syncToken;
  }

  async clearSyncToken() {
    return this.storageManager.removeItem("syncToken");
  }

  async setCursorToken(token) {
    this._cursorToken = token;
    if(token) {
      await this.storageManager.setItem("cursorToken", token);
    } else {
      await this.storageManager.removeItem("cursorToken");
    }
  }

  async getCursorToken() {
    if(!this._cursorToken) {
      this._cursorToken = await this.storageManager.getItem("cursorToken");
    }
    return this._cursorToken;
  }

  get queuedCallbacks() {
    if(!this._queuedCallbacks) {
      this._queuedCallbacks = [];
    }
    return this._queuedCallbacks;
  }

  clearQueuedCallbacks() {
    this._queuedCallbacks = [];
  }

  callQueuedCallbacksAndCurrent(currentCallback, response) {
    var allCallbacks = this.queuedCallbacks;
    if(currentCallback) {
      allCallbacks.push(currentCallback);
    }
    if(allCallbacks.length) {
      for(var eachCallback of allCallbacks) {
        eachCallback(response);
      }
      this.clearQueuedCallbacks();
    }
  }

  beginCheckingIfSyncIsTakingTooLong() {
    this.syncStatus.checker = this.$interval(function(){
      // check to see if the ongoing sync is taking too long, alert the user
      var secondsPassed = (new Date() - this.syncStatus.syncStart) / 1000;
      var warningThreshold = 5.0; // seconds
      if(secondsPassed > warningThreshold) {
        this.notifyEvent("sync:taking-too-long");
        this.stopCheckingIfSyncIsTakingTooLong();
      }
    }.bind(this), 500)
  }

  stopCheckingIfSyncIsTakingTooLong() {
    if(this.$interval.hasOwnProperty("cancel")) {
      this.$interval.cancel(this.syncStatus.checker);
    } else {
      clearInterval(this.syncStatus.checker);
    }
  }

  lockSyncing() {
    this.syncLocked = true;
  }

  unlockSyncing() {
    this.syncLocked = false;
  }

  async sync(callback, options = {}, source) {

    if(this.syncLocked) {
      console.log("Sync Locked, Returning;");
      return;
    }

    if(!options) options = {};

    if(typeof callback == 'string') {
      // is source string, used to avoid filling parameters on call
      source = callback;
      callback = null;
    }

    // console.log("Syncing from", source);

    var allDirtyItems = this.modelManager.getDirtyItems();

    // When a user hits the physical refresh button, we want to force refresh, in case
    // the sync engine is stuck in some inProgress loop.
    if(this.syncStatus.syncOpInProgress && !options.force) {
      this.repeatOnCompletion = true;
      if(callback) {
        this.queuedCallbacks.push(callback);
      }

      // write to local storage nonetheless, since some users may see several second delay in server response.
      // if they close the browser before the ongoing sync request completes, local changes will be lost if we dont save here
      this.writeItemsToLocalStorage(allDirtyItems, false);

      console.log("Sync op in progress; returning.");
      return;
    }

    let info = await this.getActiveKeyInfo();

    // we want to write all dirty items to disk only if the user is offline, or if the sync op fails
    // if the sync op succeeds, these items will be written to disk by handling the "saved_items" response from the server
    if(info.offline) {
      this.syncOffline(allDirtyItems, callback);
      this.modelManager.clearDirtyItems(allDirtyItems);
      return;
    }

    var isContinuationSync = this.syncStatus.needsMoreSync;

    this.syncStatus.syncOpInProgress = true;
    this.syncStatus.syncStart = new Date();
    this.beginCheckingIfSyncIsTakingTooLong();

    let submitLimit = 100;
    var subItems = allDirtyItems.slice(0, submitLimit);
    if(subItems.length < allDirtyItems.length) {
      // more items left to be synced, repeat
      this.syncStatus.needsMoreSync = true;
    } else {
      this.syncStatus.needsMoreSync = false;
    }

    if(!isContinuationSync) {
      this.syncStatus.total = allDirtyItems.length;
      this.syncStatus.current = 0;
    }

    // If items are marked as dirty during a long running sync request, total isn't updated
    // This happens mostly in the case of large imports and sync conflicts where duplicated items are created
    if(this.syncStatus.current > this.syncStatus.total) {
      this.syncStatus.total = this.syncStatus.current;
    }

    // when doing a sync request that returns items greater than the limit, and thus subsequent syncs are required,
    // we want to keep track of all retreived items, then save to local storage only once all items have been retrieved,
    // so that relationships remain intact
    if(!this.allRetreivedItems) {
      this.allRetreivedItems = [];
    }

    // We also want to do this for savedItems
    if(!this.allSavedItems) {
      this.allSavedItems = [];
    }

    var params = {};
    params.limit = 150;

    await Promise.all(subItems.map((item) => {
      var itemParams = new SFItemParams(item, info.keys, info.version);
      itemParams.additionalFields = options.additionalFields;
      return itemParams.paramsForSync();
    })).then((itemsParams) => {
      params.items = itemsParams;
    })

    for(var item of subItems) {
      // Reset dirty counter to 0, since we're about to sync it.
      // This means anyone marking the item as dirty after this will cause it so sync again and not be cleared on sync completion.
      item.dirtyCount = 0;
    }

    params.sync_token = await this.getSyncToken();
    params.cursor_token = await this.getCursorToken();

    var onSyncCompletion = function(response) {
      this.stopCheckingIfSyncIsTakingTooLong();
    }.bind(this);

    var onSyncSuccess = async function(response) {
      // Check to make sure any subItem hasn't been marked as dirty again while a sync was ongoing
      var itemsToClearAsDirty = [];
      for(var item of subItems) {
        if(item.dirtyCount == 0) {
          // Safe to clear as dirty
          itemsToClearAsDirty.push(item);
        }
      }
      this.modelManager.clearDirtyItems(itemsToClearAsDirty);
      this.syncStatus.error = null;

      this.notifyEvent("sync:updated_token", await this.getSyncToken());

      // Filter retrieved_items to remove any items that may be in saved_items for this complete sync operation
      // When signing in, and a user requires many round trips to complete entire retrieval of data, an item may be saved
      // on the first trip, then on subsequent trips using cursor_token, this same item may be returned, since it's date is
      // greater than cursor_token. We keep track of all saved items in whole sync operation with this.allSavedItems
      // We need this because singletonManager looks at retrievedItems as higher precendence than savedItems, but if it comes in both
      // then that's problematic.
      let allSavedUUIDs = this.allSavedItems.map((item) => {return item.uuid});
      response.retrieved_items = response.retrieved_items.filter((candidate) => {return !allSavedUUIDs.includes(candidate.uuid)});

      // Map retrieved items to local data
      // Note that deleted items will not be returned
      var retrieved = await this.handleItemsResponse(response.retrieved_items, null, SFModelManager.MappingSourceRemoteRetrieved);

      // Append items to master list of retrieved items for this ongoing sync operation
      this.allRetreivedItems = this.allRetreivedItems.concat(retrieved);

      // Merge only metadata for saved items
      // we write saved items to disk now because it clears their dirty status then saves
      // if we saved items before completion, we had have to save them as dirty and save them again on success as clean
      var omitFields = ["content", "auth_hash"];

      // Map saved items to local data
      var saved = await this.handleItemsResponse(response.saved_items, omitFields, SFModelManager.MappingSourceRemoteSaved);

      // Append items to master list of saved items for this ongoing sync operation
      this.allSavedItems = this.allSavedItems.concat(saved);

      // Create copies of items or alternate their uuids if neccessary
      var unsaved = response.unsaved;
      this.handleUnsavedItemsResponse(unsaved)

      await this.writeItemsToLocalStorage(saved, false);

      this.syncStatus.syncOpInProgress = false;
      this.syncStatus.current += subItems.length;

      // set the sync token at the end, so that if any errors happen above, you can resync
      this.setSyncToken(response.sync_token);
      this.setCursorToken(response.cursor_token);

      onSyncCompletion(response);

      if(await this.getCursorToken() || this.syncStatus.needsMoreSync) {
        setTimeout(function () {
          this.sync(callback, options, "onSyncSuccess cursorToken || needsMoreSync");
        }.bind(this), 10); // wait 10ms to allow UI to update
      } else if(this.repeatOnCompletion) {
        this.repeatOnCompletion = false;
        setTimeout(function () {
          this.sync(callback, options, "onSyncSuccess repeatOnCompletion");
        }.bind(this), 10); // wait 10ms to allow UI to update
      } else {
        await this.writeItemsToLocalStorage(this.allRetreivedItems, false);

        // The number of changed items that constitute a major change
        // This is used by the desktop app to create backups
        let majorDataChangeThreshold = 10;
        if(
          this.allRetreivedItems.length >= majorDataChangeThreshold ||
          saved.length >= majorDataChangeThreshold ||
          unsaved.length >= majorDataChangeThreshold
        ) {
          this.notifyEvent("major-data-change");
        }

        this.callQueuedCallbacksAndCurrent(callback, response);
        this.notifyEvent("sync:completed", {retrievedItems: this.allRetreivedItems, savedItems: this.allSavedItems});

        this.allRetreivedItems = [];
        this.allSavedItems = [];
      }
    }.bind(this);

    try {
      this.httpManager.postAbsolute(await this.getSyncURL(), params, function(response){

        try {
          onSyncSuccess(response);
        } catch(e) {
          console.log("Caught sync success exception:", e);
        }

      }.bind(this), function(response, statusCode){
        if(statusCode == 401) {
          alert("Your session has expired. New changes will not be pulled in. Please sign out and sign back in to refresh your session.");
        }
        console.log("Sync error: ", response);
        var error = response ? response.error : {message: "Could not connect to server."};

        this.syncStatus.syncOpInProgress = false;
        this.syncStatus.error = error;
        this.writeItemsToLocalStorage(allDirtyItems, false);

        onSyncCompletion(response);

        this.notifyEvent("sync:error", error);

        this.callQueuedCallbacksAndCurrent(callback, {error: "Sync error"});
      }.bind(this));
    }
    catch(e) {
      console.log("Sync exception caught:", e);
    }
  }

  async handleItemsResponse(responseItems, omitFields, source) {
    var keys = (await this.getActiveKeyInfo()).keys;
    await SFJS.itemTransformer.decryptMultipleItems(responseItems, keys);
    var items = this.modelManager.mapResponseItemsToLocalModelsOmittingFields(responseItems, omitFields, source);

    // During the decryption process, items may be marked as "errorDecrypting". If so, we want to be sure
    // to persist this new state by writing these items back to local storage. When an item's "errorDecrypting"
    // flag is changed, its "errorDecryptingValueChanged" flag will be set, so we can find these items by filtering (then unsetting) below:
    var itemsWithErrorStatusChange = items.filter((item) => {
      var valueChanged = item.errorDecryptingValueChanged;
      // unset after consuming value
      item.errorDecryptingValueChanged = false;
      return valueChanged;
    });
    if(itemsWithErrorStatusChange.length > 0) {
      this.writeItemsToLocalStorage(itemsWithErrorStatusChange, false);
    }

    return items;
  }

  refreshErroredItems() {
    var erroredItems = this.modelManager.allItems.filter((item) => {return item.errorDecrypting == true});
    if(erroredItems.length > 0) {
      this.handleItemsResponse(erroredItems, null, SFModelManager.MappingSourceLocalRetrieved);
    }
  }

  async handleUnsavedItemsResponse(unsaved) {
    if(unsaved.length == 0) {
      return;
    }

    console.log("Handle unsaved", unsaved);

    var i = 0;
    var handleNext = async () => {
      if(i >= unsaved.length) {
        // Handled all items
        this.sync(null, {additionalFields: ["created_at", "updated_at"]});
        return;
      }

      var mapping = unsaved[i];
      var itemResponse = mapping.item;
      await SFJS.itemTransformer.decryptMultipleItems([itemResponse], (await this.getActiveKeyInfo()).keys);
      var item = this.modelManager.findItem(itemResponse.uuid);

      if(!item) {
        // Could be deleted
        return;
      }

      var error = mapping.error;

      if(error.tag === "uuid_conflict") {
        // UUID conflicts can occur if a user attempts to
        // import an old data archive with uuids from the old account into a new account
        this.modelManager.alternateUUIDForItem(item, () => {
          i++;
          handleNext();
        }, true);
      }

      else if(error.tag === "sync_conflict") {
        // Create a new item with the same contents of this item if the contents differ

        // We want a new uuid for the new item. Note that this won't neccessarily adjust references.
        itemResponse.uuid = null;

        var dup = this.modelManager.createDuplicateItem(itemResponse);
        if(!itemResponse.deleted && !item.isItemContentEqualWith(dup)) {
          this.modelManager.addItem(dup);
          dup.conflict_of = item.uuid;
          dup.setDirty(true);
        }

        i++;
        handleNext();
      }
    }

    handleNext();
  }
}
