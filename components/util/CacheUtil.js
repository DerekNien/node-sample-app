/**
 * This file contains (rudimentary) utilities for simplifying data flow 
 * between MySql (through Sequelize) and the Client, via NoGap.
 * Cached data is not tracked by the other side, and needs to be sent over the wire explicitely.
 *
 * =Use caches=
 * There is no cache coherence (i.e. no data binding)
 * All of the cache data needs to be sent/requested explicitely, using:
 *  -> Host: `sendObject[s]Update` to send data to Client
 *  -> Client: `readObject[s]` to request data from Host
 *
 * =Declare caches=
 * 1. A component can declare caches using the `Base.Private.Caches` property.
 * 2. You can add `InstanceProto` to define instance members on all fetched objects available both on `Client` and `Host`.
 * 3. You can customize cache behavior, by providing the `members` property in your cache declaration.
 *  -> E.g. if you want to add associations or access checks, you can override `compileReadObjectsQuery`.
 *  -> E.g. for custom post-query processing, you can override `onReadObject[s]` (Host).
 *  -> E.g. you can override `onAddedObject` `onRemovedObject` (Client).
 * 4. There are different `CacheEndpoint` classes for `Client` and `Host`.
 * 5. Many methods (such as `getModel` and `compileReadObjectsQuery`) are Host-only.
 *      If they contain sensitive code, you can just declare them in `Host.Private.Caches` instead of `Base`.
 *
 * TODO: Make sure, cache does not grow unbounded
 * TODO: Account for paging + better access management
 * TODO: Cache coherence (i.e. data binding)
 * TODO: Unified query language to use on Client + Host.
 */
"use strict";


var NoGapDef = require('nogap').Def;


module.exports = NoGapDef.component({
    Namespace: 'bjt',

    /**
     * Base is available in both, host and client.
     */
    Base: NoGapDef.defBase(function(SharedTools, Shared, SharedContext) {
        var CacheUtilInstance;
        return {
            Private: {
                __ctor: function() {
                    CacheUtilInstance = this;

                    /**
                     * Map of all existing caches, indexed by name.
                     */
                    this.cacheEndpoints = {};
                },


                // ##########################################################################################
                // Instances of cached objects

                /**
                 * Instance base class.
                 * Any InstanceProto will be derived from this.
                 */
                InstanceClassBase: squishy.createClass(function(data) {
                    // ctor

                    // copy data into object
                    for (var propName in data) {
                        this[propName] = data[propName];
                    }
                },{
                    // methods

                    /**
                     * `initialize` function is called right after construction.
                     */
                    initialize: function(cache) {
                        Object.defineProperty(this, 'Instance', { value: cache.Instance });
                    },

                    /**
                     * `getSerializableRawData` is called by the transport layer to get the raw data.
                     */
                    getSerializableRawData: function() {
                        // return object itself
                        return this;
                    }
                }),


                // ##########################################################################################
                // Installing

                initCaches: function() {
                    // install caches
                    this.Instance.forEach(function(component) {
                        this._autoInstallComponentCaches(component);
                    }.bind(this));

                    // install cache event handlers
                    this.Instance.forEach(function(component) {
                        this._installCacheEventHandlers(component);
                    }.bind(this));
                },

                /**
                 * Install caches of given declarations in the given component.
                 */
                installComponentCaches: function(component, cacheDescriptors, autoInit) {
                    cacheDescriptors = cacheDescriptors || component.Caches;

                    if (cacheDescriptors instanceof Function) {
                        cacheDescriptors = cacheDescriptors.call(component, this);
                    }

                    for (var cacheName in cacheDescriptors) {
                        console.assert(cacheName, 
                            'Failed to install cache. Invalid cache declaration has no name in component: `' + 
                                component.Shared + '`.');

                        var cacheDescriptor = cacheDescriptors[cacheName];
                        this.installComponentCache(component, cacheName, cacheDescriptor, autoInit);
                    };
                },

                /**
                 * Add the given cache to the set of the given component's caches (if not added yet)
                 * and install it.
                 */
                installComponentCache: function(component, cacheName, cacheDescriptor, autoInit) {
                    // Make sure, the cache can be added as-is to the component
                    console.assert(!component[cacheName], 
                        'Failed to install cache. Component `' + component.Shared + 
                        '` already defined instance property with name of cache `' + 
                        cacheName + '`. ' +
                        'Make sure that component instance properties do not have the same name as ' + 
                        'any cache, defined by that component.');

                    // ignore manually initialized caches during auto-init phase
                    if (cacheDescriptor.manualInit) {
                        console.log(cacheName);
                    }
                    if (autoInit && cacheDescriptor.manualInit) return null;

                    // ensure correct `idGetter` function
                    var idGetter = cacheDescriptor.idGetter || 
                        (cacheDescriptor.idProperty ? 
                            eval('(function(obj) { return obj.' + cacheDescriptor.idProperty + ' } )') :
                            cacheDescriptor.idGetter);
                    console.assert(idGetter instanceof Function, 
                        'Failed to install cache. Invalid cache declaration did ' +
                        'not define Function `idGetter` or String `idProperty`: ' + cacheName + '');

                    // ensure correct `idSetter` function
                    var idSetter = cacheDescriptor.idSetter || 
                        (cacheDescriptor.idProperty ? 
                            eval('(function(obj, value) { obj.' + cacheDescriptor.idProperty + ' = value; } )') :
                            cacheDescriptor.idGetter);
                    console.assert(idSetter instanceof Function, 
                        'Failed to install cache. Invalid cache declaration did ' +
                        'not define Function `idSetter` or String `idProperty`: ' + cacheName + '');

                    if (cacheDescriptor.InstanceProto) {
                        // build InstanceClass and add to cache description
                        console.assert(typeof(cacheDescriptor.InstanceProto) === 'object', 
                            'InstanceProto of cache instances must be an object ' +
                            'containing instance methods only. Instead of providing a constructor, ' +
                            'simply override the `initialize` method.');
                        cacheDescriptor.members = cacheDescriptor.members || {};

                        cacheDescriptor.members.InstanceClass = squishy.extendClass(
                            this.InstanceClassBase,
                            cacheDescriptor.InstanceProto);
                    }

                    // create cache endpoint
                    var cache;
                    try {
                        // create cache endpoint from cache descriptor
                        cache = this._createCacheEndpoint(component,
                            cacheName, idGetter, idSetter, cacheDescriptor);

                        // add method to cacheDescriptor object to retrieve cache instance
                        cacheDescriptor.getCache = function() { return cache; };

                        // call events
                        if (component.onCacheCreated) {
                            component.onCacheCreated(cache);
                        }
                    }
                    catch (err) {
                        throw new Error('Failed to install cache. An error occured for `' + cacheName + 
                            '` in component `' + component.Shared + '` - ' + err.stack);
                    }
                    this.Tools.traceLog('Initialized cache `' + cacheName + '` in component `' + component.Shared + '`.');

                    return cache;
                },

                _createCacheEndpoint: function(component, cacheName, 
                        idGetter, idSetter, cacheDescriptor) {

                    // make sure, cache is not yet registered for this instance set
                    if (this.cacheEndpoints[cacheName]) {
                        throw new Error('Tried to register cache with same name twice: ' + cacheName);
                    }

                    // get to the creation part
                    var model = component.Shared.Model;
                    var otherMembers = cacheDescriptor.members;
                    var CacheClass = this.Shared.CacheEndpoint;

                    var cache = new CacheClass(cacheDescriptor);
                    cache.idGetter = idGetter;
                    cache.idSetter = idSetter;
                    cache.idProperty = cacheDescriptor.idProperty;
                    cache.Instance = component.Instance;
                    cache.name = cacheName;

                    cache.getModel = function() {
                        console.assert(model, 'Cache\'s component did neither define `Model` nor override `getModel` - ' + 
                            cacheName);
                        return model;
                    };

                    // add other members and overrides
                    if (otherMembers) {
                        for (var key in otherMembers) {
                            var member = otherMembers[key];
                            cache[key] = member;
                        }
                    }

                    // add cache object to cache registry
                    this.cacheEndpoints[cacheName] = cache;

                    // add cache object to component
                    component[cacheName] = cache;

                    return cache;
                },

                /**
                 * This is called internally to automatically install caches of given component.
                 * This will not initialize caches that are explicitly marked as "manualInit".
                 */
                _autoInstallComponentCaches: function(component) {
                    var cacheDescriptors = component.Caches;
                    if (!cacheDescriptors || component._Caches_initialized) return;

                    this.installComponentCaches(component, cacheDescriptors);

                    component._Caches_initialized = 1;      // prevent repeated initialization
                },

                /**
                 * Install cache event handlers.
                 */
                _installCacheEventHandlers: function(component) {
                    // hook-up all cache events
                    if (!component.cacheEventHandlers || component._Caches_EventHandlers_initialized) return;

                    for (var cacheName in component.cacheEventHandlers) {
                        var callbacks = component.cacheEventHandlers[cacheName];
                        var cache = this.getCacheEndpoint(cacheName);
                        console.assert(cache, 'Invalid entry in `' + component.Shared._def.FullName + 
                            '.cacheEventHandlers`: Cache `' + cacheName + '` does not exist, or has not been initialized yet.');

                        var events = cache.events;
                        console.assert(events, 'Invalid entry in `' + component.Shared._def.FullName + 
                            '.cacheEventHandlers`: Cache `' + cacheName + '` does not have property `events`.');

                        for (var eventName in callbacks) {
                            // get event
                            var evt = events[eventName];
                            console.assert(evt, 'Invalid entry in `' + component.Shared._def.FullName + 
                                '.cacheEventHandlers`: Cache `' + cacheName + 
                                '` does not have event property `events.' + eventName + '`.');

                            // get callback function
                            var callback = callbacks[eventName];
                            console.assert(callback instanceof Function, 
                                'Invalid entry in `' + component.Shared._def.FullName + 
                                '.cacheEventHandlers`: Entry `' + eventName + '` is not a function.');

                            // hook up callback function to the event
                            evt.addListener(callback);
                        }
                    }

                    component._Caches_EventHandlers_initialized = 1;      // prevent repeated initialization
                },


                // ##########################################################################################
                // Indexing

                _Index: squishy.createClass(function(indexDef) {
                    // ctor
                    this._indexDef = indexDef;
                    this._root = {};
                },{
                    // methods

                    /**
                     * Gets (and creates if not existing) the node
                     * that matches the given specification
                     */
                    getOrCreateNode: function(obj) {
                        var indexDef = this._indexDef;
                        var node = this._root;

                        for (var iProp = 0; iProp < indexDef.key.length-1; ++iProp) {
                            var propertyName = indexDef.key[iProp];
                            if (!obj.hasOwnProperty(propertyName)) break;    // we don't have that info
                            var val = obj[propertyName];

                            // create object if it does not exist yet
                            node = node[val] = node[val] || {};
                        }

                        return node;
                    },

                    /**
                     * Gets the array or object that matches the given specification.
                     * In case of a non-unique index, if such an object was not cached,
                     * returns newly created empty array.
                     */
                    get: function(arg0OrArgs) {
                        var args;
                        if (arg0OrArgs instanceof Array) {
                            // all arguments in one array
                            args = arg0OrArgs;
                        }
                        else {
                            args = arguments;
                        }

                        var indexDef = this._indexDef;
                        console.assert(args.length == indexDef.key.length, 
                            'Invalid arguments for cache index `get` function. ' +
                            'Argument count did not match key length: ' + args);

                        var node = this._root;
                        for (var i = 0; i < args.length-1; ++i) {
                            var val = args[i];

                            // create object if it does not exist yet
                            node = node[val] = node[val] || {};
                        }

                        // found container node of the object we are looking for
                        var leafValue = _.last(args);
                        if (!indexDef.unique && !node[leafValue]) {
                            // create empty array
                            node[leafValue] = [];
                        }
                        return node[leafValue];
                    },

                    _getContainerNode: function(obj) {
                        var indexDef = this._indexDef;
                        var node = this._root;

                        for (var iProp = 0; iProp < indexDef.key.length-1; ++iProp) {
                            var propertyName = indexDef.key[iProp];
                            var val = obj[propertyName];

                            // create object if it does not exist yet
                            node = node[val] = node[val] || {};
                        }

                        return node;
                    },

                    _addInstance: function(obj) {
                        var indexDef = this._indexDef;

                        // get object's container node
                        var node = this._getContainerNode(obj);
                        var leafPropertyName = _.last(indexDef.key);
                        var leafValue = obj[leafPropertyName];

                        if (!indexDef.unique) {
                            // create array, if it does not exist yet
                            var arr = node[leafValue] = node[leafValue] || [];

                            // add object
                            arr.push(obj);
                        }
                        else {
                            // not an array -> One unique object
                            if (node[leafValue]) {
                                console.error('Object was added twice to unique index `' + 
                                    indexDef.name + '`:');

                                // separate console line gives us the browser's internal object inspector
                                console.error(obj);
                            }
                            // add object
                            node[leafValue] = obj;
                        }
                    },

                    _removeInstance: function(obj) {
                        var indexDef = this._indexDef;

                        // get object's container node
                        var node = this._getContainerNode(obj);
                        var leafPropertyName = _.last(indexDef.key);
                        var leafValue = obj[leafPropertyName];

                        if (!indexDef.unique) {
                            // create array, if it does not exist yet
                            var arr = node[leafValue];
                            console.assert(arr, 'Tried to remove object from index ' +
                                'which has not been added in the first place: ' + obj);

                            _.remove(arr, obj);
                        }
                        else {
                            // remove object
                            delete node[leafValue];

                            // TOD: Consider porpagating and deleting parent empty ancestors as well
                        }
                    }
                }),

                /**
                 * A cache's `indices` property is of this type: 
                 * It is the set of all its (for now non-primary) indices.
                 * Each of them represented by the `_Index` type.
                 */
                IndexSet: squishy.createClass(function(indexDefs) {
                    // ctor

                    // create additional indices:
                    // Each index declaration is the name of a property.
                    // An index is currently an additional "dictionary" (or "map") object
                    //      storing an array for each unique value of that property, containing all corresponding objects.
                    console.assert(indexDefs instanceof Array,
                        'Cache definition\'s `indices` must be an array of index definitions.');
                    this._indexDefs = indexDefs;
                    for (var iDef = 0; iDef < indexDefs.length; ++iDef) {
                        var indexDef = indexDefs[iDef];

                        console.assert(indexDef && indexDef.key instanceof Array, 
                            'Each entry in cache\'s `indices` must be an object with ' +
                            'a property `key` representing a composite key in form of ' +
                            'an array of property names.');

                        // make sure, index has a proper name
                        indexDef.name = _.isString(indexDef.name) && 
                            indexDef.name ||
                            this._makeIndexName(indexDef.key);

                        // create index
                        this[indexDef.name] = new CacheUtilInstance._Index(indexDef);
                    }
                }, {
                    // methods
                    _makeIndexName: function(keyProperties) {
                        return keyProperties.join('_');
                    },

                    _addInstance: function(obj) {
                        // iterate over all indices and add object to each of them
                        var indexDefs = this._indexDefs;
                        for (var iIndex = 0; iIndex < indexDefs.length; ++iIndex) {
                            var indexDef = indexDefs[iIndex];
                            var index = this[indexDef.name];
                            index._addInstance(obj);
                        }
                    },

                    _removeInstance: function(obj) {
                        // iterate over all indices and remove object from each of them
                        var indexDefs = this._indexDefs;
                        for (var iIndex = 0; iIndex < indexDefs.length; ++iIndex) {
                            var indexDef = indexDefs[iIndex];
                            var index = this[indexDef.name];
                            index._removeInstance(obj);
                        }
                    }
                }),


                // ################################################################################################
                // Cache management

                /**
                 * The host-side cache endpoint is a data provider to the client-side cache.
                 */
                getCacheEndpoint: function(cacheName) {
                    return this.cacheEndpoints[cacheName];
                },

            },


            // ################################################################################################
            // Cache base class

            /**
             * Class from which all cache objects are derived.
             */
            CacheEndpointBase: squishy.createClass(function() {
                // ctor
                /**
                 * This cache's events
                 */
                this.events = {
                    /**
                     * Available: Both
                     * Called right after a new object has been wrapped.
                     */
                    wrapped: squishy.createEvent(/* newObject */),

                    /**
                     * Endpoints: Both
                     * Called when the host signaled that the query did not succeed.
                     */
                    error: squishy.createEvent(/* err */),

                    /**
                     * Endpoints: Client
                     * Called when sending read request (for one or more objects) to Host.
                     */
                    sendingReadQueryToHost: squishy.createEvent(/* queryInput */),

                    /**
                     * Endpoints: Client
                     * Called right before updating the cache with all deltas that have been sent by the server.
                     * The given data might contain previously cached data, in addition to uncached data.
                     */
                    updating: squishy.createEvent(/* newData, queryInput, cache */),

                    /**
                     * Endpoints: Client
                     * Called right after updating the cache with all deltas that have been sent by the server.
                     */
                    updated: squishy.createEvent(/* newData, queryInput, cache */),

                    /**
                     * Endpoints: Client
                     * Called right after an object has been removed from cache.
                     */
                    removed: squishy.createEvent(/* newObject */),
                };
            }, {
                // methods

                // ####################################################################
                // Read

                readObject: squishy.abstractMethod(/* queryInput */),

                readObjects: squishy.abstractMethod(/* queryInput */),

                /**
                 * Alias for `readObject`.
                 * Any cache endpoint that has local caching enabled, will look-up from cache instead.
                 * NOTE: `id` must correspond to `idGetter` or `idProperty` of the cache declaration.
                 */
                getObject: function(queryInput) {
                    // object needs to be fetched from DB
                    return this.readObject(queryInput);
                },

                getObjects: function(queryInput) {
                    // if (this.map[id]) {
                    //     // objects were already cached?
                    //     var objs = this.getObjectsNow(queryInput);
                    //      if (!objs) ...
                    // }
                    // else 
                    {
                        // objects need to be fetched from DB
                        return this.readObjects(queryInput);
                    }
                },


                /**
                 * Get object from cache. This only returns something on endpoints with a local cache storage (i.e. Client).
                 * NOTE: The id must correspond to `idGetter` or `idProperty` of the cache declaration.
                 */
                getObjectNow: function(id) {
                    return null;
                },


                /**
                 * Get object from cache. This only returns something on endpoints with a local cache storage (i.e. Client).
                 * NOTE: The id must correspond to `idGetter` or `idProperty` of the cache declaration.
                 */
                getObjectNowById: function(id) {
                    return this.map && this.map[id];
                },


                // ####################################################################
                // Object wrapping

                /**
                 * Called on every piece of data from the DB, on Client, as well as Host.
                 * If a prototype/ctor is given, creates a new object of given prototype/ctor, and given data.
                 * Might return a different (e.g. re-constructed) object.
                 */
                wrapObject: function(data) {
                    if (!data) return null;

                    var obj;
                    if (this.InstanceClass) {
                        console.assert(this.InstanceClass instanceof Function, 
                            'INTERNAL ERROR: Cache InstanceClass must be a constructor.');

                        // create new object, set `data`, then initialize.
                        obj = new this.InstanceClass(data);
                        obj.initialize(this);
                    }
                    else {
                        obj = data;
                    }

                    // notify event handlers
                    this.onWrapObject(obj);
                    this.events.wrapped.fire(obj);

                    return obj;
                },
                
                /**
                 * Called when given new object has been retrieved from DB, Client or Host, and just wrapped.
                 * This is to emulate ActiveRecord functionality (wrap database rows into full objects).
                 */
                onWrapObject: function(object) {
                },

                onError: function(err) {
                    this.Instance.CacheUtil.Tools.handleError(err, 'Cache error for `' + this.name + '`');
                },

                // ####################################################################
                // Create, Update + Delete
            })
        }
    }),



    /**
     * 
     */
    Host: NoGapDef.defHost(function(SharedTools, Shared, SharedContext) {
        var componentsRoot = '../';
        var libRoot = componentsRoot + '../lib/';
        var SequelizeUtil;

        return {
            __ctor: function() {
                SequelizeUtil = require(libRoot + 'SequelizeUtil');

                /**
                 * Host-side cache endpoint class.
                 */
                this.CacheEndpoint = squishy.extendClass(this.CacheEndpointBase, function() {
                    // ctor
                    this._super();

                    // Host-side cache endpoint, does not have in-memory set.
                    // Must always go through DB (for now).
                    this.list = null;
                    this.map = null;
                },{
                    // methods

                    // ####################################################################
                    // Explicit access checks

                    hasWritePermissions: function() {
                        var user = this.Instance.User.currentUser;

                        // only for staff members by default
                        return Shared.User.isStaff(user);
                    },


                    // ####################################################################
                    // Events

                    /**
                     * Called after object has just been fetched from DB.
                     * Can be overwritten for customized post-query processing.
                     */
                    onReadObject: function(object) {
                        return object;
                    },

                    onCreateObject: function(object) {
                        return object;
                    },

                    /**
                     * Called after objects have just been fetched from DB.
                     * Can be overwritten for customized post-query processing.
                     */
                    onReadObjects: function(objects) {
                        return objects;
                    },


                    // ####################################################################
                    // Overwritable compile* functions

                    /**
                     * Compiles a sequelize query to get a single rows matching (client-)given queryInput.
                     * Note: When a custom query or access checks are necessary, you can
                     *      supply a method override via `members.compileReadObjectQuery`
                     *      in your cache definition.
                     */
                    compileReadObjectQuery: function(queryInput) {
                        // get object from table
                        if (isNaN(queryInput)) {
                            // three possibilities:
                            // 1. Your code has a bug and you forgot to override `compileReadObjectQuery` to handle custom queryInput
                            // 2. Your code has a bug and initiated a request with invalid queryInput
                            // 3. User cheated and sent invalid queryInput.
                            console.warn('Client requested object from cache `' + this.name + 
                                '` with queryInput: ' + squishy.objToString(queryInput, true, 3));
                            return Promise.reject('error.invalid.request');
                        }
                        else {
                            // return id
                            return queryInput;
                        }
                    },

                    /**
                     * Compiles a sequelize query to get multiple rows matching (client-)given queryInput.
                     * Note: When a custom query is necessary, you can
                     *      supply a method override via `members.compileReadObjectsQuery`
                     *      in your cache definition.
                     */
                    compileReadObjectsQuery: function(queryInput) {
                        if (queryInput) {
                            // three possibilities:
                            // 1. Your code has a bug and you forgot to override `compileReadObjectsQuery` to handle custom queryInput
                            // 2. Your code has a bug and initiated a request with invalid queryInput
                            // 3. User cheated and sent invalid queryInput.
                            console.warn('Client requested objects from cache `' + this.name + 
                                '` with queryInput: ' + squishy.objToString(queryInput, true, 3));
                            return Promise.reject('error.invalid.request');
                        }
                        else {
                            // return empty filter
                            return {};
                        }
                    },
                    
                    compileObjectCreate: function(queryInput) {
                        if (!this.hasWritePermissions()) {
                            // only for staff members
                            return Promise.reject('error.invalid.permissions');
                        }
                        else {
                            // staff permissions -> Simply forward the request
                            // (still kinda dangerous)
                            return queryInput;
                        }
                    },

                    /**
                     * Default Update query
                     */
                    compileObjectUpdate: function(updateData) {
                        var objId;
                        if (!this.hasWritePermissions()) {
                            // only for staff members
                            return Promise.reject('error.invalid.permissions');
                        }
                        else if (!this.idProperty) {
                            console.error('Cache `' + this.name + '` did not define `idProperty` ' +
                                'but that requires overriding `compileObjectUpdate`.');
                            return Promise.reject('error.internal');
                        }
                        else if (isNaN(objId = this.idGetter(updateData))) {
                            // `updateData` must contain id
                            return Promise.reject('error.invalid.request');
                        }
                        else {
                            // build arguments to update call
                            var selector = { where: {} };
                            selector.where[this.idProperty] = objId;

                            return {
                                values: updateData,
                                selector: selector
                            };
                        }
                    },

                    compileObjectDelete: function(objId) {
                        if (!this.hasWritePermissions()) {
                            // only for staff members
                            return Promise.reject('error.invalid.permissions');
                        }
                        else if (!this.idProperty) {
                            console.error('Cache `' + this.name + '` did not define `idProperty` ' +
                                'but that requires overriding `compileObjectDelete`.');
                            return Promise.reject('error.internal');
                        }
                        else {
                            // build arguments to delete call
                            var selector = { where: {} };
                            selector.where[this.idProperty] = objId;

                            return Promise.resolve({
                                id: objId,
                                selector: selector
                            });
                        }
                    },


                    // ####################################################################
                    // Send

                    /**
                     * Send object delta to Client.
                     */
                    applyChange: function(object) {
                        this.applyChanges(object && [object]);

                        return Promise.resolve(object)
                        .bind(this)
                        .then(this.wrapObject);
                    },

                    /**
                     * Send object deltas to Client.
                     */
                    applyChanges: function(objects) {
                        this.Instance.CacheUtil.client.applyChanges(this.name, objects);
                        // TODO: also wrap it
                    },

                    /**
                     * Query object and send to client.
                     * For many cache implementations, `queryInput` is simply the object's id.
                     */
                    applyChangeFromQuery: function(queryInput) {
                        // query object from DB
                        return this.readObject(queryInput)
                        .then(function(object) {
                            // send to client
                            this.Instance.CacheUtil.client.applyChanges(this.name, object && [object]);
                        });
                    },

                    /**
                     * Query objects and send to client.
                     */
                    applyChangesFromQuery: function(queryInput) {
                        // query objects from DB
                        return this.readObjects(queryInput)
                        .then(function(objects) {
                            // send to client
                            this.Instance.CacheUtil.client.applyChanges(this.name, objects);
                        });
                    },

                    /**
                     * Tell client to remove the given object or object of given id
                     * to be removed from cache.
                     */
                    sendRemove: function(objectOrId) {
                        var id;
                        var idGetter = this.idGetter;
                        
                        if (isNaN(objectOrId)) {
                            // argument is not a number: We assume object is given
                            // -> lookup id
                            id = idGetter.call(this, objectOrId)
                        }
                        else {
                            // argument is a number: We assume, id is given
                            id = objectOrId;
                        }

                        // send request to client
                        this.Instance.CacheUtil.client.removeFromCachePublic(this.name, id);
                    },


                    // ####################################################################
                    // Read

                    /**
                     * Query data from DB.
                     */ 
                    readObject: function(queryInput) {
                        return Promise.resolve(queryInput)
                        .bind(this)

                        // first, get query metadata
                        .then(this.compileReadObjectQuery)

                        // then, query actual data from DB
                        .then(function(queryData) {
                            var model = this.getModel();
                            console.assert(model && model.find,
                                '`getModel` did not return a valid Sequelize model.');

                            // run DB query and return POD
                            return model.find(queryData)
                            .then(function(resultRow) {
                                if (!resultRow) {
                                    return Promise.reject(['cache.error.object.notFound', queryInput]);
                                }
                                else {
                                    return SequelizeUtil.getValuesFromRows(resultRow, queryData && queryData.include);
                                }
                            });
                        })
                        .bind(this)
                        .then(this.wrapObject)
                        .then(this.onReadObject);
                    },

                    /**
                     * Query data from DB.
                     */ 
                    readObjects: function(queryInput) {
                        return Promise.resolve(queryInput)
                        .bind(this)

                        // first, get query metadata
                        .then(this.compileReadObjectsQuery)

                        // then, query actual data from DB
                        .then(this.findObjects);
                    },

                    findObjects: function(queryData) {
                        var model = this.getModel();
                        console.assert(model && model.find,
                            '`getModel` did not return a valid Sequelize model.');

                        // run DB query
                        return model.findAll(queryData)
                        .then(function(resultRows) {
                            // get only plain data
                            return SequelizeUtil.getValuesFromRows(resultRows, queryData && queryData.include);
                        })

                        // wrap, call events, then return result
                        .bind(this)
                        .map(this.wrapObject)
                        .then(this.onReadObjects);
                    },


                    // ####################################################################
                    // Create, Update + Delete

                    /**
                     * Insert new object into DB
                     */
                    createObject: function(queryInput, dontSendToClient) {
                        return Promise.resolve(queryInput)
                        .bind(this)
                        .then(this.compileObjectCreate.bind(this))
                        .tap(function() {
                            //console.log('creating: ' + queryInput)
                        })

                        // send create request to DB
                        .then(this.getModel().create.bind(this.getModel()))
                        .then(SequelizeUtil.getValuesFromRows)
                        .bind(this)
                        .then(this.wrapObject)
                        .then(this.onCreateObject)
                        .then(function(newObj) {
                            // first, update client-side endpoint
                            if (!dontSendToClient) {
                                this.applyChange(newObj);
                            }

                            // return new object
                            return newObj;
                        });
                    },

                    /**
                     * Store updates to object in DB
                     */
                    updateObject: function(queryInput, dontSendToClient) {
                        return Promise.resolve(queryInput)
                        .bind(this)
                        .then(this.compileObjectUpdate)
                        .then(function(objectUpdateData) {
                            if (!objectUpdateData) {
                                return Promise.reject('error.invalid.request');
                            }

                            var objValues = objectUpdateData.values;
                            var selector = objectUpdateData.selector;

                            // update things in DB
                            return this.getModel().update(objValues, selector)
                            .bind(this)
                            .then(function() {
                                if (!dontSendToClient) {
                                    // update client-side endpoint
                                    this.applyChange(objValues);
                                }
                            });
                        });
                    },

                    /**
                     * Delete object from DB
                     */
                    deleteObject: function(queryInput, dontSendToClient) {
                        return this.compileObjectDelete(queryInput)
                        .bind(this)
                        .then(function(objectDeleteData) {
                            var objId = objectDeleteData.id;
                            var selector = objectDeleteData.selector;

                            // send query to DB
                            return this.getModel().destroy(selector)
                            .bind(this)
                            .then(function(/*, affectedRows*/) {
                                if (!dontSendToClient) {
                                    // update client-side endpoint
                                    this.sendRemove(objId);
                                }
                            });
                        });
                    },
                });
            },

            Private: {
                __ctor: function() {
                },

                /**
                 * The min role of users to access data associated of any cache.
                 */
                getMinRole: function() {
                    return Shared.AppConfig.getValue('minAccessRole');
                }
            },
            
            /**
             * Public commands can be directly called by the client
             */
            Public: {
                fetchObject: function(cacheName, queryInput) {
                    var dataProvider = this.getCacheEndpoint(cacheName);
                    if (!dataProvider) {
                        console.warn('Invalid cacheName for `fetchObject`: ' + cacheName);
                        return Promise.reject('error.invalid.request');
                    }
                    else if (!this.Instance.User.hasRole(this.getMinRole())) {
                        return Promise.reject('error.invalid.permissions');
                    }
                    else {
                        // query object and send back to client
                        return dataProvider.readObject(queryInput);
                    }
                },

                fetchObjects: function(cacheName, queryInput) {
                    var dataProvider = this.getCacheEndpoint(cacheName);

                    if (!dataProvider) {
                        console.warn('Invalid cacheName for `fetchObjects`: ' + cacheName);
                        return Promise.reject('error.invalid.request');
                    }
                    else if (!this.Instance.User.hasRole(this.getMinRole())) {
                        return Promise.reject('error.invalid.permissions');
                    }
                    else {
                        // query objects and send back to client
                        return dataProvider.readObjects(queryInput);
                    }
                },

                createObject: function(cacheName, objectValues) {
                    var dataProvider = this.getCacheEndpoint(cacheName);

                    if (!dataProvider) {
                        console.warn('Invalid cacheName for `createObject`: ' + cacheName);
                        return Promise.reject('error.invalid.request');
                    }
                    else if (!this.Instance.User.hasRole(this.getMinRole())) {
                        return Promise.reject('error.invalid.permissions');
                    }
                    else {
                        // createObject
                        return dataProvider.createObject(objectValues, true)
                        .then(function(newObject) {
                            // only send back new object's id
                            var newId = dataProvider.idGetter.call(dataProvider, newObject);
                            return newId;
                        });
                    }
                },

                updateObject: function(cacheName, objectValues) {
                    var dataProvider = this.getCacheEndpoint(cacheName);

                    if (!dataProvider) {
                        console.warn('Invalid cacheName for `updateObject`: ' + cacheName);
                        return Promise.reject('error.invalid.request');
                    }
                    else if (!this.Instance.User.hasRole(this.getMinRole())) {
                        return Promise.reject('error.invalid.permissions');
                    }
                    else {
                        // updateObject
                        return dataProvider.updateObject(objectValues, true);
                    }
                },

                deleteObject: function(cacheName, objId) {
                    var dataProvider = this.getCacheEndpoint(cacheName);

                    if (!dataProvider) {
                        console.warn('Invalid cacheName for `deleteObject`: ' + cacheName);
                        return Promise.reject('error.invalid.request');
                    }
                    else if (!this.Instance.User.hasRole(this.getMinRole())) {
                        return Promise.reject('error.invalid.permissions');
                    }
                    else {
                        // deleteObject
                        return dataProvider.deleteObject(objId, true);
                    }
                }
            },
        };
    }),
    
    
    /**
     * Everything defined in `Client` lives only in the client.
     *
     */
    Client: NoGapDef.defClient(function(Tools, Instance, Context) {
        return {
            __ctor: function() {
                // ################################################################################################
                // Client-side cache endpoint implementation

                var CacheUtilInstance = this;

                this.CacheEndpoint = squishy.extendClass(this.CacheEndpointBase, function(cacheDescriptor) {
                    // ctor
                    this._super(cacheDescriptor);

                    // a cache stores a list and map of the same set of objects:
                    // Lists make iterating faster, while maps make look-up (search by id) faster.
                    this.list = [];
                    this.map = {};                    

                    if (cacheDescriptor.indices) {
                        // create indices
                        this.indices = new CacheUtilInstance.IndexSet(cacheDescriptor.indices);
                    }

                    // count how often the cache was updated
                    this.nUpdates = 0;
                }, {
                    // methods

                    // ################################################################################################
                    // Coherence

                    /**
                     * Called when given object has been added to cache.
                     */
                    onAddedObject: function(object) {
                    },

                    /**
                     * Called when given object has been removed from cache.
                     */
                    onRemovedObject: function(object) {
                    },

                    /**
                     * Called after the given object updates have been applied to the cache.
                     */
                    onCacheChanged: function(newData) {
                    },

                    applyChange: function(obj, queryInput) {
                        var newObjects = this._applyChanges([obj], queryInput);
                        return newObjects[0];
                    },

                    /**
                     * This is likely to grow differently from the internal `_applyChanges` function.
                     * In the future, it will probably provide additional checks and flavors.
                     */
                    applyChanges: function(newData, queryInput) {
                        return this._applyChanges(newData, queryInput);
                    },

                    /**
                     * Shallow-merges the given array of `newData` into the cached objects.
                     * Shallow-merge means that the data of each object in the `newData` array is merged
                     * into the cached object of same id, by shallow-copying each property.
                     * Simply adds the object to the cache, if it was not cached previously.
                     *
                     * @see http://en.wikipedia.org/wiki/Object_copy#Shallow_copy
                     */
                    _applyChanges: function(data, queryInput) {
                        var list = this.list;
                        var map = this.map;
                        var idGetter = this.idGetter;

                        // keep track only of changed objects
                        var newData = [];

                        if (data) {
                            // 1. remove all non-updates
                            for (var iObj = 0; iObj < data.length; ++iObj) {
                                var newValues = data[iObj];
                                var id = idGetter.call(this, newValues);

                                console.assert(id, 'Invalid object had no but NEEDS an id in `Cache._applyChanges` ' +
                                    'of cache `' + this.name + '` - ' +
                                    'That happens either because the object does not have an id, ' +
                                    'or the cache declaration\'s `idGetter` or `idProperty` are ill-defined.');

                                var obj = map[id];
                                if (!obj) {
                                    // new object is about to be added

                                    // notify
                                    var obj = this.wrapObject(newValues);
                                    newData.push(obj);
                                }
                                else {
                                    // object was cached previously:
                                    // check if it has changed
                                    for (var propName in newValues) {
                                        var newValue = newValues[propName];
                                        var oldValue = obj[propName];
                                        if (!angular.equals(newValue, oldValue)) {
                                            // this object (probably) has changed
                                            newData.push(newValues);
                                            break;
                                        }
                                    }
                                }
                            };
                        }

                        // fire "updating" event
                        this.events.updating.fire(newData, queryInput, this);

                        if (data) {
                            // 2. apply all updates only to changed objects
                            for (var iObj = 0; iObj < newData.length; ++iObj) {
                                var newValues = newData[iObj];
                                var id = idGetter.call(this, newValues);

                                var obj = map[id];
                                if (!obj) {
                                    // object was not cached previously:
                                    obj = newValues;

                                    // add new object to cache
                                    list.push(obj);
                                    map[id] = obj;

                                    // add to indices
                                    if (this.indices) {
                                        this.indices._addInstance(obj);
                                    }
                                    

                                    // fire client-side only event
                                    this.onAddedObject(obj);
                                }
                                else {
                                    // object was cached previously:
                                    // shallow-copy new properties
                                    for (var propName in newValues) {
                                        obj[propName] = newValues[propName];
                                    }

                                    // override new object with reference to old one
                                    newData[iObj] = obj;
                                }
                            };
                        }

                        // count changes applied to cache
                        ++this.nUpdates;

                        //console.log('Updated cache: ' + this.name);

                        // call internal callback
                        this.onCacheChanged(newData);

                        // fire "updated" event
                        this.events.updated.fire(newData, queryInput, this);

                        return newData;
                    },

                    /**
                     * Deletes the given object or obejct of given id from cache.
                     * NOTE: `id` must correspond to `idGetter` or `idProperty` of the cache declaration.
                     */
                    removeFromCache: function(objectOrId) {
                        var id;
                        if (isNaN(objectOrId)) {
                            // argument is not a number: We assume object is given
                            // lookup id
                            id = this.idGetter.call(this, objectOrId)
                        }
                        else {
                            // argument is a number: We assume, id is given
                            id = objectOrId;
                        }

                        // remove from key index
                        var obj = this.map[id];
                        if (obj) {
                            delete this.map[id];

                            // remove from list
                            // TODO: This is very slow (but should not be called often, so its ok)...
                            for (var i = 0; i < this.list.length; ++i) {
                                var entry = this.list[i];
                                if (this.idGetter.call(this, entry) == id) {
                                    this.list.splice(i, 1);
                                    break;
                                }
                            };

                            // remove from indices
                            if (this.indices) {
                                this.indices._removeInstance(obj);
                            }

                            // notify
                            this.onRemovedObject.call(this, obj);
                            this.events.removed.fire(obj);
                        }

                        // return deleted object
                        return obj;
                    },


                    // ################################################################################################
                    // Read

                    /**
                     * Get object from cache.
                     * NOTE: The id must correspond to `idGetter` or `idProperty` of the cache declaration.
                     */
                    getObjectNow: function(queryInput) {
                        // TODO: Support query language to also support general queryInputs on the cache
                        if (isNaN(queryInput)) {
                            // two main possibilities:
                            // 1. illegal user request
                            // 2. forgot to override `getObjectNow`
                            return Promise.reject('error.invalid.request');
                        }
                        return this.map[queryInput];        // look up by id
                    },

                    /**
                     * Get list of all currently cached objects.
                     */
                    getObjectsNow: function(queryInput) {
                        // TODO: Support query language to also support general queryInputs on the cache
                        return this.list;
                    },

                    /**
                     * Get object asynchronously.
                     * Returns promise.
                     */
                    getObject: function(queryInput) {
                        var obj = this.getObjectNow(queryInput);
                        if (obj) {
                            // object was already cached -> return Promise
                            return Promise.resolve(obj);
                        }
                        else {
                            // object needs to be fetched from DB
                            return this.readObject(queryInput);
                        }
                    },

                    /**
                     * Read single object from Host.
                     * NOTE: `id` must correspond to `idGetter` or `idProperty` of the cache declaration.
                     */ 
                    readObject: function(queryInput) {
                        return this.Instance.CacheUtil.host.fetchObject(this.name, queryInput)
                        .bind(this)
                        .then(function(object) {
                            // add array of objects
                            return this.applyChange(object, queryInput);
                        })
                        .catch(function(err) {
                            err = err || ['cache.error.object.notFound', queryInput];
                            this.onError(err);
                        });
                    },

                    /**
                     * Read one or more objects from Host.
                     */
                    readObjects: function(queryInput) {
                        // fire event
                        this.events.sendingReadQueryToHost.fire(queryInput);

                        // get objects from server
                        return this.Instance.CacheUtil.host.fetchObjects(this.name, queryInput)
                        .bind(this)
                        .then(function(objects) {
                            return this._applyChanges(objects, queryInput);
                        })
                        .catch(function(err) {
                            err = err || ['cache.error.objects.notFound', queryInput];
                            this.onError(err);
                        });
                    },


                    // ################################################################################################
                    // Create, Update, Delete

                    /**
                     * Send creation request to host.
                     */
                    createObject: function(queryInput) {
                        var newObj = queryInput;
                        return this.Instance.CacheUtil.host.createObject(this.name, newObj)
                        .bind(this)
                        .then(function(newObjId) {
                            // set id
                            this.idSetter(newObj, newObjId);

                            // add to cache + return
                            this.applyChange(newObj);
                            return newObj;
                        }.bind(this));
                    },

                    /**
                     * Send update request to host.
                     */
                    updateObject: function(queryInput) {
                        // TODO: Support arbitrary queryInput
                        var id = this.idGetter(queryInput);
                        var origObj = _.clone(this.getObjectNowById(id));
                        console.assert(origObj, '`updateObject` called with invalid object: ' + origObj);

                        // apply changes right away
                        this.applyChange(queryInput);

                        return this.Instance.CacheUtil.host.updateObject(this.name, queryInput)
                        .bind(this)
                        .then(function() {
                            // update succeeded
                        })
                        .catch(function(err) {
                            // update failed -> rollback
                            this.applyChange(origObj);
                            this.Instance.CacheUtil.Tools.handleError(err);
                        });
                    },

                    /**
                     * Send delete request to host.
                     */
                    deleteObject: function(objectOrId) {
                        var id;
                        if (isNaN(objectOrId)) {
                            // argument is not a number: We assume object is given
                            // lookup id
                            id = this.idGetter.call(this, objectOrId)
                        }
                        else {
                            // argument is a number: We assume, id is given
                            id = objectOrId;
                        }

                        // apply changes right away
                        var origObj = this.removeFromCache(objectOrId);
                        console.assert(origObj, '`deleteObject` called with invalid objectOrId: ' + objectOrId)

                        // send request to host
                        return this.Instance.CacheUtil.host.deleteObject(this.name, id)
                        .bind(this)
                        .then(function() {
                            // deletion succeeded
                        })
                        .catch(function(err) {
                            // deletion failed -> rollback
                            this.applyChange(origObj);

                            // TODO: Handle error better
                            this.Instance.CacheUtil.Tools.handleError(err);
                        });
                    }
                });
            },

            initClient: function() {
                this.initCaches();
            },

            onNewComponent: function(component) {
                this._autoInstallComponentCaches(component);
                this._installCacheEventHandlers(component);
            },


            /**
             * Client commands can be directly called by the host
             */
            Public: {
                /**
                 * Host sent changed data.
                 */
                applyChanges: function(cacheName, objects) {
                    var cache = this.getCacheEndpoint(cacheName);
                    if (!cache) {
                        console.error('Invalid argument `cacheName` for `applyChanges` (cache does not exist): ' + cacheName);
                        return;
                    }
                    
                    //console.log(cacheName + ' - update: ' + squishy.objToString(objects));
                    cache._applyChanges(objects);
                },

                removeFromCachePublic: function(cacheName, objectId) {
                    var cache = this.getCacheEndpoint(cacheName);
                    if (!cache) {
                        console.error('Invalid argument `cacheName` for `removeFromCache` (cache does not exist): ' + cacheName);
                        return;
                    }

                    cache.removeFromCache(objectId);
                }
            }
        };
    })
});