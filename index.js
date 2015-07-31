var less = require('less');
var fs = require("fs");
var loaderUtils = require("loader-utils");
var path = require("path");

var color = require('color');
var LessColor = require('less/lib/less/tree/color');
var isString = require('lodash.isstring');

var lessFuncs = less.functions.functionRegistry._data;

function lessVarNameToJsName(name) {
	var replaced = name.replace(/\-./g, function (match) {
		return match.charAt(1).toUpperCase();
	});
	return replaced.slice(1); // getting rid of the @
}

function convertLeafNode(v, variablesSoFar) {
	if (v.name === 'lighten' || v.name === 'darken') {
		var sourceColor = convertLeafNode(v.args[0].value[0], variablesSoFar);
		var sourceColorLess;
		if (sourceColor instanceof LessColor) {
			sourceColorLess = sourceColor;
		} else {
			var sourceColorParsedRGB = color(sourceColor).rgb();
			sourceColorLess = lessFuncs.rgb(
				sourceColorParsedRGB.r,
				sourceColorParsedRGB.g,
				sourceColorParsedRGB.b);
		}
		return lessFuncs[v.name](sourceColorLess, v.args[1].value[0]).toRGB();
	}

	if (v.name) {
		return variablesSoFar[v.name];
	}

	if (v.rgb && v.alpha) {
		return [
			'rgba(', v.rgb[0], ',', v.rgb[1], ',', v.rgb[2], ',', v.alpha, ')'
		].join('');
	}
	if (v.rgb && !v.alpha) {
		return [
			'rgb(', v.rgb[0], ',', v.rgb[1], ',', v.rgb[2], ')'
		].join('');
	}

	var unit = v.unit;
	if (unit &&
		unit.denominator &&
		unit.denominator.length === 0 &&
		unit.numerator[0] === 'px') {
		return v.value;
	}
	if (unit &&
		unit.denominator &&
		unit.denominator.length === 0 &&
		unit.numerator[0] === '%') {
		return v.value + '%';
	}

	if (v.quote) {
		return v.quote + v.value + v.quote;
	}

	if (v.value) {
		return v.value;
	}

	return v;
}

function convertLessValueToJs(v, variablesSoFar) {
	if (!v.value && Array.isArray(v) && v.length === 1) {
		return convertLeafNode(v[0], variablesSoFar);
	}

	var val = v.value;

	if (Array.isArray(val)) {
		var arr = val.map(function (item) {
			if (item.value) {
				return convertLessValueToJs(item.value, variablesSoFar);
			} else {
				return item;
			}
		});

		if (arr.every(function (e) { return isString(e) })) {
			return arr.join(', ');
		}

		return arr.length === 1 ? arr[0] : arr;
	}

	return convertLeafNode(v);
}

function extractFromRules(rules, variablesSoFar) {
	variablesSoFar = variablesSoFar || {};

	rules.forEach(function (rule) {
		if (rule.importedFilename) {
			var importedRules = extractFromRules(rule.root.rules, variablesSoFar);
			variablesSoFar = Object.assign(variablesSoFar, importedRules);
		}

		if (rule.variable && rule.name && rule.value) {
			variablesSoFar[rule.name] =
				convertLessValueToJs(rule.value, variablesSoFar);
		}
	});

	return variablesSoFar;
}

var trailingSlash = /[\\\/]$/;

module.exports = function(source) {
	var loaderContext = this;
	var query = loaderUtils.parseQuery(this.query);
	var cb = this.async();
	var isSync = typeof cb !== "function";
	var finalCb = cb || this.callback;
	var configKey = query.config || "lessLoader";
	var config = {
		filename: this.resource,
		paths: [],
		relativeUrls: true,
		compress: !!this.minimize
	};
	var webpackPlugin = {
		install: function(less, pluginManager) {
			var WebpackFileManager = getWebpackFileManager(less, loaderContext, query, isSync);

			pluginManager.addFileManager(new WebpackFileManager());
		},
		minVersion: [2, 1, 1]
	};

	this.cacheable && this.cacheable();

	Object.keys(query).forEach(function(attr) {
		config[attr] = query[attr];
	});

	// Now we're adding the webpack plugin, because there might have
	// been added some before via query-options.
	config.plugins = config.plugins || [];
	config.plugins.push(webpackPlugin);

	// If present, add custom LESS plugins.
	if (this.options[configKey]) {
		config.plugins = config.plugins.concat(this.options[configKey].lessPlugins || []);
	}

	// not using the `this.sourceMap` flag because css source maps are different
	// @see https://github.com/webpack/css-loader/pull/40
	if (query.sourceMap) {
		config.sourceMap = {
			outputSourceFiles: true
		};
	}

	less.parse(source, config, function (e, tree) {
		var cb = finalCb;
		// Less is giving us double callbacks sometimes :(
		// Thus we need to mark the callback as "has been called"
		if(!finalCb) return;
		finalCb = null;
		if(e) return cb(formatLessRenderError(e));

		var lessVariables = extractFromRules(tree.rules);

		var jsVariables = {};
		Object.keys(lessVariables).forEach(function (key) {
			jsVariables[lessVarNameToJsName(key)] = lessVariables[key];
		});

		cb(null, "module.exports = " + JSON.stringify(jsVariables));
	});
};

function getWebpackFileManager(less, loaderContext, query, isSync) {

	function WebpackFileManager() {
		less.FileManager.apply(this, arguments);
	}

	WebpackFileManager.prototype = Object.create(less.FileManager.prototype);

	WebpackFileManager.prototype.supports = function(filename, currentDirectory, options, environment) {
		// Our WebpackFileManager handles all the files
		return true;
	};

	WebpackFileManager.prototype.supportsSync = WebpackFileManager.prototype.supports;

	WebpackFileManager.prototype.loadFile = function(filename, currentDirectory, options, environment, callback) {
		// Unfortunately we don't have any influence on less to call `loadFile` or `loadFileSync`
		// thus we need to decide for ourselves.
		// @see https://github.com/less/less.js/issues/2325
		if (isSync) {
			try {
				callback(null, this.loadFileSync(filename, currentDirectory, options, environment));
			} catch (err) {
				callback(err);
			}

			return;
		}

		var moduleRequest = loaderUtils.urlToRequest(filename, query.root);
		// Less is giving us trailing slashes, but the context should have no trailing slash
		var context = currentDirectory.replace(trailingSlash, "");

		loaderContext.resolve(context, moduleRequest, function(err, filename) {
			if(err) {
				callback(err);
				return;
			}

			loaderContext.dependency && loaderContext.dependency(filename);
			// The default (asynchronous)
			loaderContext.loadModule("-!" + __dirname + "/stringify.loader.js!" + filename, function(err, data) {
				if(err) {
					callback(err);
					return;
				}

				callback(null, {
					contents: JSON.parse(data),
					filename: filename
				});
			});
		});
	};

	WebpackFileManager.prototype.loadFileSync = function(filename, currentDirectory, options, environment) {
		var moduleRequest = loaderUtils.urlToRequest(filename, query.root);
		// Less is giving us trailing slashes, but the context should have no trailing slash
		var context = currentDirectory.replace(trailingSlash, "");
		var data;

		filename = loaderContext.resolveSync(context, moduleRequest);
		loaderContext.dependency && loaderContext.dependency(filename);
		data = fs.readFileSync(filename, "utf8");

		return {
			contents: data,
			filename: filename
		};
	};

	return WebpackFileManager;
}

function formatLessRenderError(e) {
	// Example ``e``:
	//	{ type: 'Name',
	//		message: '.undefined-mixin is undefined',
	//		filename: '/path/to/style.less',
	//		index: 352,
	//		line: 31,
	//		callLine: NaN,
	//		callExtract: undefined,
	//		column: 6,
	//		extract:
	//		 [ '    .my-style {',
	//		 '      .undefined-mixin;',
	//		 '      display: block;' ] }
	var extract = e.extract? "\n near lines:\n   " + e.extract.join("\n   ") : "";
	var err = new Error(
		e.message + "\n @ " + e.filename +
		" (line " + e.line + ", column " + e.column + ")" +
		extract
	);
	err.hideStack = true;
	return err;
}
