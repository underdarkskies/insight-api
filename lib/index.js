'use strict';

var Writable = require('stream').Writable;
var bodyParser = require('body-parser');
var compression = require('compression');
var BaseService = require('./service');
var inherits = require('util').inherits;
var BlockController = require('./blocks');
var StatisticsController = require('./statistics');
var TxController = require('./transactions');
var AddressController = require('./addresses');
var AssetController = require('./assets');
var StatusController = require('./status');
var MessagesController = require('./messages');
var UtilsController = require('./utils');
var CurrencyController = require('./currency');
var MarketsController = require('./markets');
var Db = require('../components/Db');
var RateLimiter = require('./ratelimiter');
var morgan = require('morgan');
var ravencore = require('ravencore-lib');
var _ = ravencore.deps._;
var $ = ravencore.util.preconditions;
var Transaction = ravencore.Transaction;
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var SupplyHelper = require('../helpers/SupplyHelper');

var LastBlockRepository = require('../repositories/LastBlockRepository');
var AddressBalanceRepository = require('../repositories/AddressBalanceRepository');
var StatisticDayRepository = require('../repositories/StatisticDayRepository');
var AddressBlocksMinedRepository = require('../repositories/AddressBlocksMinedRepository');

var StatisticService = require('../services/StatisticService');
var TransactionService = require('../services/TransactionService');
var MarketsService = require('../services/MarketsService');
var AddressBalanceService = require('../services/AddressBalanceService');
var AddressBlocksMinedService = require('../services/AddressBlocksMinedService');

/**
 * A service for Ravencore to enable HTTP routes to query information about the blockchain.
 *
 * @param {Object} options
 * @param {Boolean} options.enableCache - This will enable cache-control headers
 * @param {Number} options.cacheShortSeconds - The time to cache short lived cache responses.
 * @param {Number} options.cacheLongSeconds - The time to cache long lived cache responses.
 * @param {String} options.routePrefix - The URL route prefix
 */
var InsightAPI = function(options) {
  BaseService.call(this, options);

  var self = this;
  // in minutes
  this.currencyRefresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;

  this.subscriptions = {
    inv: [],
    raven: []
  };

  if (!_.isUndefined(options.enableCache)) {
    $.checkArgument(_.isBoolean(options.enableCache));
    this.enableCache = options.enableCache;
  }
  this.cacheShortSeconds = options.cacheShortSeconds;
  this.cacheLongSeconds = options.cacheLongSeconds;

  this.rateLimiterOptions = options.rateLimiterOptions;
  this.disableRateLimiter = options.disableRateLimiter;
  this.dbConfig = options.db;

  this.blockSummaryCacheSize = options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE;
  this.blockCacheSize = options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE;

  if (!_.isUndefined(options.routePrefix)) {
    this.routePrefix = options.routePrefix;
  } else {
    this.routePrefix = this.name;
  }

  this.statisticDayRepository = new StatisticDayRepository();
  this.lastBlockRepository = new LastBlockRepository();
  this.addressBalanceRepository = new AddressBalanceRepository();
  this.addressBlocksMinedRepository = new AddressBlocksMinedRepository();

  this.statisticService = new StatisticService({node: this.node, statisticDayRepository: this.statisticDayRepository, lastBlockRepository: this.lastBlockRepository});

  this.transactionService = new TransactionService({node: this.node})

  this.txController = new TxController({node: this.node, transactionService: this.transactionService});

    //Block routes
    var blockOptions = {
        node: this.node,
        blockSummaryCacheSize: this.blockSummaryCacheSize,
        blockCacheSize: this.blockCacheSize,
        transactionService: this.transactionService
    };

  this.blocksController = new BlockController(blockOptions);

  this.coinShort = options.coinShort || 'RVN';
  this.coinTicker = options.coinTicker || 'https://api.coinmarketcap.com/v1/ticker/ravencoin/?convert=USD';

    /**
     * TODO::exception
     */
  if (this.dbConfig) {

      this.db = new Db(this.node, this.dbConfig);

      this.db.connect(function(err) {

          if (err) {
              return self.node.log.error('db.connect error');
          }

      });

  } else {
      self.node.log.warn('dbConfig is empty');
  }

  this.marketsService = new MarketsService({node: this.node});
  this.addressBalanceService = new AddressBalanceService({marketsService: this.marketsService, lastBlockRepository: self.lastBlockRepository, addressBalanceRepository: self.addressBalanceRepository, node: this.node});
  this.addressBlocksMinedService = new AddressBlocksMinedService({node: this.node, addressBlocksMinedRepository: self.addressBlocksMinedRepository, lastBlockRepository: self.lastBlockRepository});

  this.statisticsController = new StatisticsController({
      node: this.node,
      addressBalanceService: this.addressBalanceService,
      statisticService: this.statisticService,
      addressBlocksMinedRepository: this.addressBlocksMinedRepository

  });
  this.statusController = new StatusController(this.node);
  this.marketsController = new MarketsController({marketsService: this.marketsService});


};

InsightAPI.dependencies = ['ravend', 'web'];

inherits(InsightAPI, BaseService);

InsightAPI.prototype.cache = function(maxAge) {
  var self = this;
  return function(req, res, next) {
    if (self.enableCache) {
      res.header('Cache-Control', 'public, max-age=' + maxAge);
    }
    next();
  };
};

InsightAPI.prototype.cacheShort = function() {
  var seconds = this.cacheShortSeconds || 30; // thirty seconds
  return this.cache(seconds);
};

InsightAPI.prototype.cacheLong = function() {
  var seconds = this.cacheLongSeconds || 86400; // one day
  return this.cache(seconds);
};

InsightAPI.prototype.getRoutePrefix = function() {
  return this.routePrefix;
};

InsightAPI.prototype.start = function(callback) {
  var self = this;

  this.node.services.ravend.on('tx', this.transactionEventHandler.bind(this));
  this.node.services.ravend.on('block', this.blockEventHandler.bind(this));

  this.marketsService.on('updated', function (info) {
    for (var i = 0; i < self.subscriptions.inv.length; i++) {
        self.subscriptions.inv[i].emit('markets_info', info);
    }
  });

  this.statisticService.on('updated', function (updInfo) {
    if (!self.subscriptions.inv.length) {
        return false;
    }
    var dataFlow = {
        info: null,
        miningInfo: null,
        supply: null
    };

    return async.waterfall([function (callback) {
        return self.statusController.getInfo(function (err, info) {
            if (err) {
                self.node.log.error('getInfo', err);
                return callback(err);
            }

            dataFlow.info = info;

            return callback();
        });
    }, function (callback) {
        return self.statusController.getMiningInfo(function (err, miningInfo) {
            if (err) {
                self.node.log.error('getMiningInfo', err);
                return callback(err);
            }

            dataFlow.miningInfo = miningInfo;

            return callback();
        });
    }], function (err) {

        if (err) {
            return false;
        }

        if (!self.subscriptions.inv.length) {
            return false;
        }

        dataFlow.supply = SupplyHelper.getTotalSupplyByHeight(updInfo.height).toString(10);

        for (var i = 0; i < self.subscriptions.inv.length; i++) {
            self.subscriptions.inv[i].emit('info', dataFlow);
        }

    });

  });

  return async.waterfall([function (callback) {
      return self.addressBalanceService.start(function (err) {
          return callback(err);
      });
  }, function (callback) {
      return self.statisticService.start(function (err) {
          return callback(err);
      })
  }, function (callback) {
      return self.addressBlocksMinedService.start(function (err) {
         return callback(err);
      });
  }], function (err) {

      if (err) {
          self.node.log.error('START ERROR', err);
      }

      setImmediate(callback);
  });
};

InsightAPI.prototype.createLogInfoStream = function() {
  var self = this;

  function Log(options) {
    Writable.call(this, options);
  }
  inherits(Log, Writable);

  Log.prototype._write = function (chunk, enc, callback) {
    self.node.log.info(chunk.slice(0, chunk.length - 1)); // remove new line and pass to logger
    callback();
  };
  var stream = new Log();

  return stream;
};

InsightAPI.prototype.getRemoteAddress = function(req) {
  if (req.headers['cf-connecting-ip']) {
    return req.headers['cf-connecting-ip'];
  }
  return req.socket.remoteAddress;
};

InsightAPI.prototype._getRateLimiter = function() {
  var rateLimiterOptions = _.isUndefined(this.rateLimiterOptions) ? {} : _.clone(this.rateLimiterOptions);
  rateLimiterOptions.node = this.node;
  var limiter = new RateLimiter(rateLimiterOptions);
  return limiter;
};

InsightAPI.prototype.setupRoutes = function(app) {

  var self = this;

  //Enable rate limiter
  if (!this.disableRateLimiter) {
    var limiter = this._getRateLimiter();
    app.use(limiter.middleware());
  }

  //Setup logging
  morgan.token('remote-forward-addr', function(req){
    return self.getRemoteAddress(req);
  });
  var logFormat = ':remote-forward-addr ":method :url" :status :res[content-length] :response-time ":user-agent" ';
  var logStream = this.createLogInfoStream();
  app.use(morgan(logFormat, {stream: logStream}));

  //Enable compression
  app.use(compression());

  //Enable urlencoded data
  app.use(bodyParser.urlencoded({extended: true}));

  app.use(function(req, res, next) {
    var origin = req.get('origin');
    if (origin == null) {
      // either browser directly, or via insight on the same server
      next();
    } else if (!(self.node.allowedOriginRegexp.test(origin))) {
      res.status(405).send('Origin ' + origin + ' not allowed.');
    } else {
      next();
    }
  });

  //Statistics routes

  app.get('/supply', this.cacheShort(), this.statisticsController.totalSupply.bind(this.statisticsController));
  app.get('/statistics/total-supply', this.cacheShort(), this.statisticsController.totalSupply.bind(this.statisticsController));
  app.get('/statistics/circulating-supply', this.cacheShort(), this.statisticsController.circulatingSupply.bind(this.statisticsController));
  app.get('/statistics/supply', this.cacheShort(), this.statisticsController.supply.bind(this.statisticsController));
  app.get('/statistics/fees', this.cacheShort(), this.statisticsController.fees.bind(this.statisticsController));
  app.get('/statistics/network-hash', this.cacheShort(), this.statisticsController.nethashps.bind(this.statisticsController));
  app.get('/statistics/pools', this.cacheShort(), this.statisticsController.pools.bind(this.statisticsController));
  app.get('/statistics/pools-last-hour', this.cacheShort(), this.statisticsController.poolsLastHour.bind(this.statisticsController));
  app.get('/statistics/transactions', this.cacheShort(), this.statisticsController.transactions.bind(this.statisticsController));
  app.get('/statistics/outputs', this.cacheShort(), this.statisticsController.outputs.bind(this.statisticsController));
  app.get('/statistics/difficulty', this.cacheShort(), this.statisticsController.difficulty.bind(this.statisticsController));
  app.get('/statistics/total', this.cacheShort(), this.statisticsController.total.bind(this.statisticsController));
  app.get('/statistics/balance-intervals', this.cacheShort(), this.statisticsController.balanceIntervals.bind(this.statisticsController));
  app.get('/statistics/richer-than', this.cacheShort(), this.statisticsController.getRicherThan.bind(this.statisticsController));
  app.get('/statistics/richest-addresses-list', this.cacheShort(), this.statisticsController.getRichestAddressesList.bind(this.statisticsController));

  //Blocks routes

  var blocks = this.blocksController;
  app.get('/blocks', this.cacheShort(), blocks.list.bind(blocks));


  app.get('/block/:blockHash', this.cacheShort(), blocks.checkBlockHash.bind(blocks), blocks.show.bind(blocks));
  app.param('blockHash', blocks.block.bind(blocks));

  app.get('/rawblock/:blockHash', this.cacheLong(), blocks.checkBlockHash.bind(blocks), blocks.showRaw.bind(blocks));
  app.param('blockHash', blocks.rawBlock.bind(blocks));

  app.get('/block-index/:height', this.cacheShort(), blocks.blockIndex.bind(blocks));
  app.param('height', blocks.blockIndex.bind(blocks));

  // Transaction routes
  var transactions = new TxController({node: this.node, transactionService: this.transactionService});
  app.get('/tx/:txid', this.cacheShort(), transactions.show.bind(transactions));
  app.param('txid', transactions.transaction.bind(transactions));
  app.get('/txs', this.cacheShort(), transactions.list.bind(transactions));
  app.post('/tx/send', transactions.send.bind(transactions));

  // Raw Routes
  app.get('/rawtx/:txid', this.cacheLong(), transactions.showRaw.bind(transactions));
  app.param('txid', transactions.rawTransaction.bind(transactions));

  // Asset routes
  var assets = new AssetController({node: this.node});

  app.get('/assets', this.cacheShort(), assets.listAssets.bind(assets));

  // Address routes
  var addresses = new AddressController({node: this.node, txController: transactions});

  app.get('/addr/:addr', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.show.bind(addresses));
  app.get('/addr/:addr/utxo', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.utxo.bind(addresses));
  app.get('/addrs/:addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  app.get('/addr/:addr/asset/:asset/utxo', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.utxo.bind(addresses));
  app.get('/addrs/:addrs/asset/:asset/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  app.get('/addrs/:addrs/unspent', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.utxoWithoutMempool.bind(addresses));
  app.post('/addrs/utxo', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multiutxo.bind(addresses));
  app.get('/addrs/:addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));
  app.post('/addrs/txs', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.multitxs.bind(addresses));


  app.get('/addrs/:addrs/balance', this.cacheShort(), addresses.checkAddrs.bind(addresses), addresses.balancesum.bind(addresses));

  // Address property routes

  app.get('/addr/:addr/balance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.balance.bind(addresses));
  app.get('/addr/:addr/totalReceived', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalReceived.bind(addresses));
  app.get('/addr/:addr/totalSent', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.totalSent.bind(addresses));
  app.get('/addr/:addr/unconfirmedBalance', this.cacheShort(), addresses.checkAddr.bind(addresses), addresses.unconfirmedBalance.bind(addresses));

  // Status route

  app.get('/status', this.cacheShort(), this.statusController.show.bind(this.statusController));
  app.get('/sync', this.cacheShort(), this.statusController.sync.bind(this.statusController));
  app.get('/peer', this.cacheShort(), this.statusController.peer.bind(this.statusController));
  app.get('/version', this.cacheShort(), this.statusController.version.bind(this.statusController));

  // Messages routes
  var messages = new MessagesController(this.node);
  app.get('/messages/verify', messages.verify.bind(messages));
  app.post('/messages/verify', messages.verify.bind(messages));

  // Utils route
  var utils = new UtilsController(this.node);
  app.get('/utils/estimatesmartfee', utils.estimateSmartFee.bind(utils));

  // Currency
  var currency = new CurrencyController({
    node: this.node,
    currencyRefresh: this.currencyRefresh,
    coinTicker: this.coinTicker,
    coinShort: this.coinShort
  });
  app.get('/currency', currency.index.bind(currency));

  app.get('/markets/info', this.marketsController.getInfo.bind(this.marketsController));

  // Not Found
  app.use(function(req, res) {
    res.status(404).jsonp({
      status: 404,
      url: req.originalUrl,
      error: 'Not found'
    });
  });

};

InsightAPI.prototype.getPublishEvents = function() {
  return [
    {
      name: 'inv',
      scope: this,
      subscribe: function (emitter) {
          this.subscribe(emitter, 'inv');
      }.bind(this),
      unsubscribe: function (emitter) {
          this.unsubscribe(emitter, 'inv');
      },
      extraEvents: ['tx', 'block', 'info', 'markets_info']
    },
    {
        name: 'raven',
        scope: this,
        subscribe: function (emitter) {
            this.subscribe(emitter, 'raven');
        }.bind(this),
        unsubscribe: function (emitter) {
            this.unsubscribe(emitter, 'raven');
        },
        extraEvents: ['raven/tx', 'raven/block']
    }
  ];
};

InsightAPI.prototype.blockEventHandler = function(hashBuffer) {

  // Notify inv subscribers
  for (var i = 0; i < this.subscriptions.inv.length; i++) {
    this.subscriptions.inv[i].emit('block', hashBuffer.toString('hex'));
    this.subscriptions.inv[i].emit('test', 'test');
  }


  var self = this;

  if (self.subscriptions.raven.length) {

      this.blocksController.getBlockByHash(hashBuffer.toString('hex'), function (err, block) {

          async.mapSeries(block.tx, function(txid, next) {
              self.transactionService.getDetailedTransaction(txid, function(err, transaction) {
                  if (err) {
                      return next(err);
                  }

                  self.txController.transformTransaction(transaction, function(err, transformedTransaction) {
                      if (err) {
                          return next(err);
                      }

                      next(null, transformedTransaction);
                  });


              });
          }, function(err, transformed) {
              if(err) {
                  return ;
              }

              // Notify raven subscribers
              for (var i = 0; i < self.subscriptions.raven.length; i++) {
                  self.subscriptions.raven[i].emit('raven/block', {
                      block: block,
                      transactions: transformed ? transformed : []
                  });
              }
          });



      });

  }

};
InsightAPI.prototype.transactionEventHandler = function(txBuffer) {

   if (this.subscriptions.inv.length || this.subscriptions.raven.length) {

       var tx = new Transaction().fromBuffer(txBuffer);

       if (this.subscriptions.inv.length) {

           var result = this.txController.transformInvTransaction(tx);

           // Notify inv subscribers
           for (var i = 0; i < this.subscriptions.inv.length; i++) {
               this.subscriptions.inv[i].emit('tx', result);
           }
       }

       if (this.subscriptions.raven.length) {
           var transformedTrx = this.txController.transformRavenTransaction(tx);

           for (var i = 0; i < this.subscriptions.raven.length; i++) {
               this.subscriptions.raven[i].emit('raven/tx', transformedTrx);
           }


       }

   }




};

InsightAPI.prototype.subscribe = function(emitter, room) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions[room];
  var index = emitters.indexOf(emitter);
  if(index === -1) {
    emitters.push(emitter);
  }
};

InsightAPI.prototype.unsubscribe = function(emitter, room) {
  $.checkArgument(emitter instanceof EventEmitter, 'First argument is expected to be an EventEmitter');

  var emitters = this.subscriptions[room];
  var index = emitters.indexOf(emitter);
  if(index > -1) {
    emitters.splice(index, 1);
  }
};

module.exports = InsightAPI;
