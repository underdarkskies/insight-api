'use strict';

var ravencore = require('ravencore-lib');
var async = require('async');
var Common = require('./common');

function AssetController(opts) {
    this.node = opts.node;
    this.common = new Common({ log: this.node.log });
}

AssetController.prototype.listAssets = function(req, res) {
    var self = this;
    var asset = req.query.asset || req.body.asset || '*';
    var verbose = (req.query.verbose && req.query.verbose.toUpperCase() == 'TRUE') ||
                  (req.body.verbose && req.body.verbose.toUpperCase() == 'TRUE') ||
                  false;
    var size = parseInt(req.query.size) || parseInt(req.body.size) || 100;
    var skip = parseInt(req.query.skip) || parseInt(req.body.skip) || 0;

    this.node.listAssets(asset, verbose, size, skip, function(err, data) {

        if (err) {
            return self.common.handleErrors(err, res);
        }

        res.jsonp(data);

    });
};

module.exports = AssetController;