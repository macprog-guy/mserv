/**

mserv

@version    0.2.0
@author		Eric Methot

@license    MIT
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

var debug    = require('debug')('mserv'),
	Promise  = require('bluebird'),
	amqp     = require('amqplib'),
	async    = require('async'),
	slugid   = require('slugid'),
	Action   = require('./action'),
	co       = require('co'),
	_        = require('lodash')


module.exports = Service

/**
 
 Represents an access/end point to microservices.
 @constructor

 @param   {object} options - object with initialization options.
 @returns {object} instance of Service ready for business.

 @example  

 	new Service()
	.action({
		name: 'auth.signup', 
		handler: signup
	})
	.action({
		name: 'auth.login', 
		handler: login
	})
	.action(
		name: 'auth.activate', 
		handler: activate
	})

*/
function Service(options) {

	// Create a new instance if needed
	if (!(this instanceof Service))
		return new Service(options)

	// Combine options with defaults
	this._options = _.defaultsDeep(options || {}, { 
		amqp: 'amqp://localhost',
		callbackQueue: slugid.v4(),
		exchangeDirect: 'services',
		exchangeTopic: 'events',
		reconnectAttempts: 10,
		reconnectDelay: 200,
		disableAMQPBypass: false,
		disableAutoconnect: false,
		timeout: 2000
	})

	this.app = {}
	this.ext = {}
	this._state = 'init'
	this._connection = null
	this._channel = null
	this._rpc = {}
	this._middleware = []
	this._actions = {}
	this._registeredActions = {}
	this._subscriptions = {}
	this._registeredSubscriptions = {}
	this._queue = async.queue(worker)
	this._queue.pause()

	if (!this._options.disableAutoconnect)
		this.reconnect()

	return this;

	function worker(task, done) {
		task.work(done)
	}
}


/**

 Connects the service to the AMQP server.

 Normally you don't need to call this function because the constructor 
 automatically tries to connect to the server using reconnect. Should you close 
 the connection manually then calling `connect` or `reconnect` will get you 
 going again.

 NOTE: this function does not throw errors. On success it the promise resolves 
       to true and on failure it resolves to the Error object.

 @method

 @returns {Promise} to true or Error object.

 */

Service.prototype.connect = co.wrap(function* connect(){

	try {

		if (this._state == 'ready')
			return true
		
		var cbq  = this._options.callbackQueue,
			opts = this._options


		debug('[connect] Connecting to ' + opts.amqp + '...')
		
		this._state = 'connecting'

		var connection = yield amqp.connect(opts.amqp)
		connection.on('close', onConnectionClosedDisconnectReconnect.bind(this))
		connection.on('end',   onConnectionClosedDisconnectReconnect.bind(this))

		var channel = yield connection.createChannel()

		yield channel.assertQueue(cbq, {durable:true, exclusive:true})
		yield channel.assertExchange(opts.exchangeDirect)
		yield channel.assertExchange(opts.exchangeTopic)

		channel.prefetch(1)
		channel.consume(cbq, resolveRPC.bind(this), {noAck:true})

		this._connection = connection
		this._channel    = channel
		this._state      = 'ready'

		yield this.register()
		this._queue.resume()

		debug('[connect] Ready.')

		return connection
	} 
	catch (err) {

		debug('[connect] ' + err)
		return err
	}


	function resolveRPC(message) {

		try {
			// Get the correlationId and related promise
			var correlationId = message.properties.correlationId,
				defered = this._rpc[correlationId],
				err

			// Remove and resolve RPC
			if (defered) {

				delete this._rpc[correlationId]
				message.content = JSON.parse(message.content.toString())

				if (err = message.content && message.content.error$) {
					err = _.assign(new Error(err.message), err)
					return defered.reject(err)
				}
				return defered.resolve(message)
			}
		}
		catch(err) {

			debug('[resolveRPC] ' + err)
			return err
		}
	}

	function onConnectionClosedDisconnectReconnect() {

		try {
			if (this._state != 'ready')
				return;

			var self = this,
				reconnect = (this._options.reconnectAttempts > 0)

			self.close().then(function() {
				if (reconnect) self.reconnect()
			})
		}
		catch(err) {

			debug('[onConnectionClosedDisconnectReconnect] ' + err)
			return err
		}
	} 
})



/**

 Reconnect to the AMQP server and retry until successful or the maximum 
 number of attempts has been reached. 

 @method
 @returns {Promise} to boolean indicating success or failure.

 */

Service.prototype.reconnect = co.wrap(function* reconnect(){

	try {
		var self     = this,
		    ms       = this._options.reconnectDelay,
		    attempts = this._options.reconnectAttempts,
		    success  = yield this.connect()
				
		while(success !== true && attempts-- > 0) {
			debug('[reconnect] ' + attempts + ' attempts remaining in ' + ms + ' ms ')
			yield this.sleep(ms)
			success = yield this.connect()
		}

		return success
	}
	catch(err) {

		debug('[reconnect] ' + err)
		return err
	}
})



/**

 Manually closes the connection to the AMQP server manually.

 If the service is not ready yet then the command will be queued. 
 Anything queued command coming after a close will be played on reconnect.

 @method
 @returns {Promise} to boolean indicating success or failure.

 */

Service.prototype.close = function close() {

	var self = this

	if (self._state !== 'ready') {
		
		debug('[close] Will close later...')
		var defered = defer()
		
		this._queue.push({work: function(done){
			self.close().then(defered.resolve)
			done() 
		}})

		return defered.promise
	}
	else {

		return new Promise(function(resolve, reject){
		
			try {
				debug('[close] Closing...')
				self._state = 'closing'
				self._queue.pause()
				self._connection.close()

				delete self._connection
				delete self._channel

				self._registeredActions = {}
				self._state = 'closed'

				debug('[close] Closed.')

				return resolve(true)
			}
			catch(err) {

				debug('[close] ' + err)
				return resolve(err)
			}
		})
	}
}



/**

 Declares a plugin that may be used as middleware by actions.

 Middleware functions are executed in the same context as the action handler.
 Namely, the context contains references to the service, request, response...

 @method
 @params  {string} name - name of the plugin. Should many plugins have the same name
 						  they will share action-level options. 

 @param   {function} middleware - when called with the service and options will 
                                  returns a generator function to be executed for 
                                  each action.

 @param   {object} [options] - Options that will be passed to the middleware function.

 @return  {Service} for easy chaining.

 @example

	plugin = function(service, globalOptions) {

		// Makes globalOptions optional
		globalOptions = globalOptions || {}

		return function* (next, options) {

			// Makes options actually optional
			options = options || {}

			pre = globalOptions.prefix || '*'
			suf = options.suffix || '*'
			act = options.action

			// This will happen before the handler
			console.log('['+act+'] before:' + pre + '.' + suf
			
			yield next

			// This will happen after the handler
			console.log('['+act+'] after:' + pre + '.' + suf
		}
	}


     Service
     	.use('wrap', plugin, {prefix: 'PREFIX'})

     	.action({
			name: 'test',
			wrap: {suffix: 'SUFFIX'}, 
			handler: function*() {
				console.log('foobar')
			}
     	})

     	.command('test') 

	// Outputs
	// [test] before: PREFIX.SUFFIX
	// foobar
	// [test] after: PREFIX.SUFFIX
			

 */

Service.prototype.use = function use(name, middleware, options) {

	try {
		// Basic validation
		if (typeof name   !== 'string'  ) throw new Error('Service#use expects a name.')
		if (typeof middleware !== 'function') throw new Error('Service#use expects a function.')

		// Register the middleware
		debug('[use] Registered middleware ' + name)

		// Call setup and store the handler preserving order
		this._middleware.push({name:name, handler:middleware(this, options || {})})
	}
	catch(err) {
		debug('[use] ' + err)
	}
	finally {
		return this
	}
}

/**

 Declares service level methods available as extensions.

 */
Service.prototype.extend = function ext(name, extension, options) {
	try {
		// Basic validation
		if (typeof name !== 'string') throw new Error('Service#extend expects a name.')
		if (typeof extension !== 'function') throw new Error('Service#extend expects a function.')

		// Check that the plugins does not exist
		if (this.ext[name]) throw new Error('Extension with name ' + name + ' already exists')

		// Register the plugin
		debug('[extend] Registered extension ' + name)

		// Call the extension passing service and options
		this.ext[name] = extension(this, options || {})
	}
	catch(err) {
		debug('[extend] ' + err)
	}
	finally {
		return this
	}
}


/**

 Declares an action and its handler or returns an Action.

 @method
 @params  {object}  config - configuration object for this action.

 The following keys have special meaning and all other keys are assumed 
 to be middleware configuration:

  {string}    config.name    - of the action (actions are called by name).
  {function}  config.handler - generator function to handle requests.


 NOTE: If you declare actions dynamically after the service is connected then          
       you will need to call the `register` function.

 @returns {Service} for easy chaining.

 */

Service.prototype.action = function action(config) {

	try {
		// Extract the name from the config
		var name = config && config.name

		// Basic validation
		if (!name) 
			throw new Error('Service#action expects a name option.')

		// Check to see if the action alreay exists
		if (this._actions[name]) 
			throw new Error('Action with name ' + name + ' already exists')

		// Create the action
		this._actions[name] = new Action(config)
	}
	catch(err) {
		debug('[action] ' + err)
	}
	finally {
		return this
	}
}


/**

 Invokes a microservice action.

 @method
 @param   {string}   name  - of the microservice to invoke.
 @param   {mixed}    args  - arguments to pass the microservice.
 @praam   {boolean?} ack   - expect a response

 @returns {Promise} of invocation result if ack is true

 */

Service.prototype.invoke = function invoke(name, args, headers, ack) {

	// If headers is boolean then it's actually ack
	if (typeof headers === 'boolean') {
		headers = {}
		ack = headers
	} else {
		headers = headers || {}
	}

	// Default value for ack is true meaning we expecta reply
	if (ack === undefined || ack === null)
		ack = true

	// Optimize the call path if the service is process local
	if (this._actions[name] && !this._options.disableAMQPBypass)
		return invokeLocal.call(this, name, args, headers, ack)
	else 
		return invokeRemote.call(this, name, args, headers, ack)


	function invokeLocal(name, args, headers, ack) {
		
		var self = this

		return co(function*(){

			var action = self._actions[name]

			// Make sure the action exists
			if (!action) throw new Error('Local action ' + name + ' does not exist')

			// Create an execution context for it.
			var context = createContext.call(self, {properties:headers, content:args})

			// Even if ack is false we still need to wait for promise to resove when local
			yield action.run(self._middleware, context)

			if (ack) {
				if (context.res && context.res.error$) 
					throw _.assign(new Error(context.res.error$.message), context.res.error$)
				return context.res
			}
			return {}
		})
	}


	function invokeRemote(name, args, headers, ack) {

		try {
			var self    = this,
			    headers = {},
			    timeout = this._options.timeout || 2000,
			    defered = defer()

			// Setup callback when expecting response
			if (ack) {
				headers.replyTo = this._options.callbackQueue
				headers.correlationId = slugid.v4()
				this._rpc[headers.correlationId] = defered
			}

			// Push the invoke on the task queue
			this._queue.push(task(name, args||{}, headers, defered))

			// Return the result
			return defered.promise.then(function(res){ return ack? res.content : {} })
		}
		catch(err) {
			debug('[invokeRemote] ' + err)
			throw err
		}


		function task(name, args, headers, defered) {
			return {
				work: (function(done) {					
					let timeout = self._options.timeout || 2000
					self._channel.sendToQueue(name, new Buffer(JSON.stringify(args||{})), headers)

					if (headers.replyTo) {
						setTimeout(function(){
							debug('[invokeRemote] Timeout')
							self._rpc[headers.correlationId]
							defered.reject(new Error('Timeout: ' + name + ' did not reply within the alloted ' + timeout + 'ms'))
						}, timeout)
					} else {
						// This is a command so resolve it now.
						defered.resolve({})
					}
					debug('[invokeRemote] ' + name +'('+ JSON.stringify(args)+')')
					done() // We don't wait for the response to come back
				})
			}
		}
	}
}





/**

 Issue a command to a microservice NOT expecting a result or acknowledgement.

 @method
 @param   {string}   name  - of the microservice to invoke.
 @param   {mixed}    args  - arguments to pass the microservice.

 @returns {Promise} that command has been issued.

 */

Service.prototype.command = function command(name, args, headers) {
	this.invoke(name, args, headers, false)
}



/**

 Subscribe to topic on the topic exchange.

 @method
 @param   {string}   name    - of the microservice to invoke.
 @param   {mixed}    handler - the generator function that will handle messages.

 @returns {Promise} that command has been issued.

 */

Service.prototype.subscribe = function subscribe(config) {

	// Extract the name from the config
	var name = config && config.name

	// Basic validation
	if (!name) throw new Error('Service#subscribe expects a name option.')

	// Subscriptions don't need to be unique so we can't index by name.
	// Instead we index by the subscriptions id, which is unique.
	let sub = new Action(config)
	this._subscriptions[sub.id] = sub

	return this
}


/**

 Publish something on the topic exchange

 @method
 @param   {string}   topic   - the topic on which to publish
 @param   {mixed}    content - the content to publish

 @returns {Promise} that command has been issued.

 */

Service.prototype.publish = function publish(topic, content) {

	var self = this,
		ex   = this._options.exchangeTopic

	this._queue.push({
		work: function(done) {
			var string = JSON.stringify(content)
			debug('[publish] ' + ex + ':' + topic + '('+string+')')
			self._channel.publish(ex, topic, new Buffer(string))
			done()
		}
	})

	return this
}




/**

 Puts the script on a queue for execution.

 This is essentially a wrapper around co that allows you to invoke services and 
 issue commands. It makes it easy to write quick scripts to test ideas.

 @method
 @param   {function} generatorFunc - script to execute
 
 @returns {Self} for easy chaining.

 */

Service.prototype.script = function script(generatorFunc) {

	var context = createContext.call(this)

	this._queue.push({work: function(done){
		co(generatorFunc.bind(context))
		done() // We don't wait for the script to finish
	}})

	return this
}


/**

 Goes to sleep for some time.

 @method

 @param   {number}  ms - number of milliseconds ew should sleep.
 @returns {Promise} to return ms after some delay.

 */

Service.prototype.sleep = co.wrap(function* sleep(ms) {
	yield Promise.delay(ms, ms)
})







/**


 Registers all as of yet unregistered actions and subscriptions with the AMQP server.

 In essence registering means creating queues and assigning consumers for those
 queues. It's safe to call this as many times as needed but in practice, it's
 called by the constructor upon connection so that you don't need to call it 
 manually.

 @method

 @returns {Promise} to array of all available action names.

 */

Service.prototype.register = function register() {

	if (this._state != 'ready')
		return

	var self          = this,
		regActions    = this._registeredActions,
		regSubs       = this._registeredSubscriptions,
		channel       = this._channel,
		actions       = this._actions,
		subscriptions = this._subscriptions,
	    names         = Object.keys(actions),
	    subs          = Object.keys(subscriptions)

	return Promise.all(names.map(registerAction).concat(subs.map(registerSubscription)))


	function registerAction(name) {

		if (regActions[name]) 
			return Promise.resolve(name)

		return channel.assertQueue(name, {durable:false}).then(function(){
			var	action = actions[name]
			channel.consume(name, consumer(action, channel), {noAck:true})
			regActions[name] = true
			debug('[register] Registered action ' + name)
			return name
		})
	}

	function registerSubscription(subId) {

		if (regSubs[subId])
			return Promise.resolve(subId)

		// Use the default exchange or one 
		var sub   = subscriptions[subId],
			ex    = sub.exchange || self._options.exchangeTopic,
			topic = sub.name

		// Create a queue, bind it then consume
		return channel.assertQueue('', {durable:false}).then(function(qok){
			var queue = qok.queue
			return channel.bindQueue(queue, ex, topic).then(function(){
				channel.consume(queue, consumer(sub, channel), {noAck:true})
				regSubs[subId] = sub
				debug('[register] Registered subscription (' + subId + ') ' + ex + ':' + topic)
				return subId
			})
		})
	}

	function consumer(action, channel) {
		return co.wrap(function* _consumer(message){

			try {
				// TODO: make this a middleware eventually
				message.content = JSON.parse(message.content.toString())

				// Create a new context to handle the message
				var context = createContext.call(self, message)

				// Run the action along with the middleware
				var res = yield action.run(self._middleware, context)

				// If there is a result then set the context to that result
				if (res !== undefined) context.res = res

				// Reply the response if we have a replyTo address
				var replyTo = message.properties.replyTo

				if (replyTo) {
					var correlationId = message.properties.correlationId
					var buffer = new Buffer(JSON.stringify(context.res || 'ok'))
					channel.sendToQueue(replyTo, buffer, {correlationId:correlationId})
				}
			}
			catch(err) {
				debug('[consumer] ' + err)
			}
		})
	}
}



// ================================ PRIVATE ================================



/**

 Creates an execution context for action requests.

 @function
 @private

 @param  {object} message - the message triggering the action.

 @returns {object} context.

 */

function createContext(message) {

	var message = message || {},
		context = new Object()
	
	context.headers$ = message.properties || {}
	context.amqp$    = message.fields     || {}
	context.req      = message.content
	context.res      = {}

	context.service  = this
	context.invoke   = this.invoke.bind(this)
	context.command  = this.command.bind(this)
	context.publish  = this.publish.bind(this)

	return context
}




/**

 Returns a defered promise using the bluebird library.

 @returns {defered} promise.

 @function
 @private

 */
function defer() {
	
	var resolve, reject;
	
	var promise = new Promise(function() {
		resolve = arguments[0]
		reject  = arguments[1]
	})

	return {
		resolve: resolve,
		reject:  reject,
		promise: promise
	}
}

