/**

AMQP Microservice Action

@version    0.2.0
@author		Eric Methot

@license
Copyright (c) 2015 Eric Methot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

'use strict'

var debug   = require('debug')('amqp-microservice'),
	compose = require('koa-compose'),
	co      = require('co'),
	slugid  = require('slugid'),
	_       = require('lodash')


module.exports = Action

/**
 
 Represents an end point to microservices action.
 @constructor
 @private

 @param {object}    config - configuration with at least name and handler keys.

 @returns {Action}  the newly created action.

 @example  

 	new Action({name:'auth.signup', handler:function*{...}})

 */

function Action(config) {

	// Create a new instance if needed
	if (!(this instanceof Action))
		return new Action(options)

	// Extract the name and handler and remove them from the options
	var name     = config.name,
		handler  = config.handler,
		exchange = config.exchange

	// Check to see that we have a name
	if (!name)
		throw new Error('Name must be specified')

	// Check to see that the handler is a generator function
	if (!isGeneratorFunction(handler))
		throw new Error('Handler must be a generator function')

	this.id = slugid.v4()
	this.name     = name
	this.exchange = exchange
	this._options = _.omit(config,'name','exchange','handler')
	this._handler = handler
	this._runner  = null

	return this
}



/**

 Executes the actions and middleware bound to a given context.

 
 @param   {array}  middleware - array of {name, handle} objects.
 @param   {object} context    - the context in which the handler and middleware run.

 @returns {Promise} 
 
 */

Action.prototype.run = function run(middleware, context) {

	if (!this._runner) {

		var self    = this,
		    action  = this.name,
		    handler = this._handler,
		    genfns  = null

		genfns = middleware.map(function(ware){
			
			var name    = ware.name,
			    options = self._options[name]

			if (options === undefined)
				options = {}
			
			if (_.isPlainObject(options))
				options.action = action
			
			if (!isGeneratorFunction(ware.handler))
				throw new Error('Middleware handler expected to be a generator function')

			return function*(next) {
				return yield* ware.handler.call(this, next, options)
			}
		})

		genfns.push(function*(){
			var res = yield *handler.call(this)
			if (res !== undefined) 
				this.res = res
		})

		this._runner = compose(genfns)
	}

	return co(this._runner.bind(context)).then(
		function(){ return context.res },
		function(err) { 

			// Convert regular errors to error responses
			// Other errors are programming error!
			if (err.name === 'Error')
				context.res = {error$: _.assign({message:err.message, name:err.name}, err)}
			else {
				let error$ = {status:500, message:err.message, name:err.name, fileName:err.fileName, lineNumber:err.lineNumber}
				context.log.error({func:'action.run', action, err})
				context.res = {error$}
			}

			throw err
		}
	)
}



/**

  Checks if `obj` is a generator function.
  
  Extracted directly from the co library.

  @param   {Mixed} obj
  @returns {Boolean}
  @private

 */

function isGeneratorFunction(obj) {
  var constructor = obj.constructor;
  if (!constructor) return false;
  if ('GeneratorFunction' === constructor.name || 'GeneratorFunction' === constructor.displayName) return true;
  return isGenerator(constructor.prototype);
}

function isGenerator(obj) {
  return 'function' == typeof obj.next && 'function' == typeof obj.throw;
}
