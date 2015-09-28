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
	bunyan   = require('bunyan'),
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

	// Default log-level depends on NODE_ENV
	var loglevel = 30
	if (process.env.NODE_ENV === 'test')
		loglevel = 60

	// Combine options with defaults
	this._options = _.defaultsDeep(options || {}, { 
		amqp: 'amqp://localhost',
		app: 'mserv',
		callbackQueue: slugid.v4(),
		disableAMQPBypass: false,
		disableAutoconnect: false,
		exchangeDirect: 'services',
		exchangeTopic: 'events',
		logger: null,
		loglevel,
		reconnectAttempts: 10,
		reconnectDelay: 200,
		timeout: 2000
	})

	// Public State
	this.app = {name: this._options.app}
	this.ext = {}
	this.log = this._options.logger || bunyan.createLogger({
		name: this._options.app, 
		level:this._options.loglevel
	})


	// Private State
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
	this._registrationErrors = []

	if (!this._options.disableAutoconnect)
		this.reconnect()

	return this;

	function worker(task, done) {
		task.work(done)
	}
}

/**

 Returns the current state of the service

 */
Service.prototype.state = function state() {
	return this._state
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

		if (this._state === 'ready')
			return true
		
		var cbq  = this._options.callbackQueue,
			opts = this._options


		this.log.info({func:'connect', msg:'connecting', amqpUri:opts.amqp})		
		this._state = 'connecting'

		// Connect and setup event handlers
		var connection = yield amqp.connect(opts.amqp)
		connection.on('close', onConnClosed.bind(this))
		connection.on('end',   onConnClosed.bind(this))

		// Create the communication channel
		var channel = yield connection.createChannel()

		// Create the callback queue and exchanges
		yield channel.assertQueue(cbq, {durable:true, exclusive:true})
		yield channel.assertExchange(opts.exchangeDirect)
		yield channel.assertExchange(opts.exchangeTopic)

		// Prefetch and consume the callback queue
		channel.prefetch(1)
		channel.consume(cbq, resolveRPC.bind(this), {noAck:true})

		// Set some important state
		this._connection = connection
		this._channel    = channel
		this._state      = 'ready'

		// Register actions and subscriptions
		yield this.register()

		// Resume the AMQP call queue
		this._queue.resume()

		this.log.info({func:'connect', msg:'ready', amqpUri:opts.amqpUri})

		return connection
	} 
	catch (error) {

		// Log the error and return null
		this.log.warn({func:'connect', msg:'failed', amqpUry:this._options.amqp, error})
		throw error
	}


	function resolveRPC(message) {

		try {
			// Get the correlationId and related promise
			var correlationId = message.properties.correlationId,
				defered = this._rpc[correlationId],
				err

			// Remove and resolve RPC (maybe it has timed out)
			if (!defered)
				return this.log.error({func:'connect.resolveRPC', msg:'promise not found', message})

			delete this._rpc[correlationId]
			message.content = JSON.parse(message.content.toString())

			if (err = message.content && message.content.error$) {
				try {
					ErrorConstructor = global[err.name] || 'Error'
					err = _.assign(new ErrorConstructor(err.message), err)
				}
				catch(ignore) {
					err = _.assign(new Error(err.message), err)
				}
				return defered.reject(err)
			}
			return defered.resolve(message)
		}
		catch(error) {
			// If we reach this point then we have a programming error
			this.log.error({func:'connect.resolveRPC', msg:'internal error', error, message})
		}
	}

	function onConnClosed() {

		try {
			// Skip if state is not ready
			if (this._state != 'ready')
				return;

			// Attempt a reconnect only if reconnectAttempts > 0
			var reconnect = !!(this._options.reconnectAttempts > 0),
				self = this

			// Close and maybe reconnect
			self.close().then(function() {
				if (reconnect) self.reconnect()
			})
		}
		catch(error) {

			// If we reach this point then we have a programming error
			this.log.error({func:'connect.onConnClosed', msg:'internal error', error})
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
		// Try an initial connection
	    return yield this.connect()
	}
	catch(error) {

		let delay    = this._options.reconnectDelay,
		    attempts = this._options.reconnectAttempts

		while(attempts-- > 0) {
			this.log.info({func:'reconnect', msg:'waiting', delay})		
			yield this.sleep(delay)
			try { return yield this.connect() } catch(e) { error = e }
		}

		// We have run out of attempts so we throw
		throw error
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

	try {
		var self = this

		if (self._state !== 'ready') {
			
			return new Promise(function(resolve, reject){
				this.log.info({func:'close', msg:'queued'})		
				this._queue.push({work: function(done){
					self.close().then(resolve, reject)
					done() 
				}})
			})
		}
		else {

			return new Promise(function(resolve, reject){
			
				try {
					this.log.info({func:'close', msg:'closing'})
					self._state = 'closing'
					self._queue.pause()
					self._connection.close()

					delete self._connection
					delete self._channel

					self._registeredActions = {}
					self._state = 'closed'

					this.log.info({func:'close', msg:'closed'})
					return resolve(true)
				}
				catch(error) {
					// If we get here then the connection was probably already closed
					this.log.warn({func:'close', msg:'error', error})
					return resolve(true)
				}
			})
		}
	}
	catch(error) {

		// If we reach this point then we have a programming error
		this.log.error({func:'close', msg:'internal error', error})
		return null
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

	// Basic argument validation
	if (typeof name   !== 'string'  ) throw new Error('Service#use expects a name.')
	if (typeof middleware !== 'function') throw new Error('Service#use expects a function.')

	// Log and register the middleware
	this.log.info({func:'use', msg:'register', name})

	try {
		// Call setup and store the handler preserving order
		this._middleware.push({name:name, handler:middleware(this, options || {})})
	}
	catch(error) {
		// There was an error instantiating the middleware
		this.log.warn({func:'use', msg:'error', error})
	}
	finally {
		// Make sure we can continue in the event of an error
		return this
	}
}

/**

 Declares service level methods available as extensions.

 */
Service.prototype.extend = function extend(name, extension, options) {

	// Basic argument validation
	if (typeof name !== 'string') throw new Error('Service#extend expects a name.')
	if (typeof extension !== 'function') throw new Error('Service#extend expects a function.')
	if (this.ext[name]) throw new Error('Extension with name ' + name + ' already exists')

	// Log and register extension
	this.log.info({func:'extend', msg:'register', name})

	try {
		// Call the extension bound to this and passing options
		this.ext[name] = extension(this, options || {})
	}
	catch(error) {
		// There was an error instantiating the extension
		this.log.warn({func:'extend', msg:'error', error})
	}
	finally {
		// Make sure we can continue in the event of an error
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

	// Extract the name from the config
	var name = config && config.name

	// Basic argument validation
	if (!name) throw new Error('Service#action expects a name option.')
	if (this._actions[name]) throw new Error('Service#action ' + name + ' already exists.')

	// Create the action
	try {
		this._actions[name] = new Action(config)
		this.log.info({func:'action', msg:'registered', name})
	}
	catch(error) {
		// There was an error instantiating the action
		this.log.warn({func:'action', msg:'error', name, error})
		this._registrationErrors.push(name)
	}
	finally {
		// Make sure we can continue in the event of an error
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

	// Rearrange arguments: if headers is boolean then it's actually ack
	if (typeof headers === 'boolean') {
		headers = {}
		ack = headers
	} else {
		headers = headers || {}
	}

	// Default value for ack is true meaning we expect a reply
	if (ack === undefined || ack === null)
		ack = true

	// Call invokeRemote by default but do try to optimize call path if possible.
	if (this._actions[name] && !this._options.disableAMQPBypass)
		return invokeLocal.call(this, name, args, headers, ack)
	else
		return invokeRemote.call(this, name, args, headers, ack)
	


	function invokeLocal(name, args, headers, ack) {
		
		var self = this

		return co(function*(){

			try {
				// Log the invoke
				self.log.info({func:'invoke.local', msg:'run', name, args, headers, ack})

				// Get the action from our internal actions dictionary
				var action = self._actions[name]

				// Create an execution context for it. It won't be exactly the same but good enough.
				var context = createContext.call(self, {properties:headers, content:args})

				// If ack is true then we wait otherwise we just run
				var promise = action.run(self._middleware, context)

				if (ack) {
					// Wait for the call to resolve
					yield promise

					// If the response has an error$ then convert it to an Error and throw
					if (context.res && context.res.error$) 
						throw _.assign(new Error(context.res.error$.message), context.res.error$)

					// Otherwise just return the response
					return context.res
				}

				// For commands return true as in "command issued"
				return true
			}
			catch(error) {
				// If we get here the promise probably threw an error
				self.log.error({func:'invoke.local', msg:'error', error})
				throw error
			}
		})
	}



	function invokeRemote(name, args, headers, ack) {

		try {

			let self    = this,
			    headers = {},
			    timeout = this._options.timeout || 2000,
			    defered = defer()

			self.log.info({func:'invoke.remote', msg:'queued', name, args, headers, ack})


			// Setup callback when expecting response
			if (ack) {
				headers.replyTo = this._options.callbackQueue
				headers.correlationId = slugid.v4()
				this._rpc[headers.correlationId] = defered
			}

			// Push the invoke on the AMQP queue
			this._queue.push({
				work: function(done) {

					// Log that we are actually running
					self.log.info({func:'invoke.remote', msg:'run', name, args, headers, ack})

					// Send the message on the named queue
					self._channel.sendToQueue(name, new Buffer(JSON.stringify(args||{})), headers)

					// If we are waiting for a reply then set a timeout so that we are not waiting forever
					if (headers.replyTo) {
						setTimeout(function(){
							// Log that the timout delay has elapsed
							self.log.info({func:'invoke.remote',msg:'timeout', delay:timeout, name, args, headers, ack})

							// Remove the stored promise
							delete self._rpc[headers.correlationId]

							// Reject the promise
							defered.reject(new Error('Timeout'))
						}, timeout)
					} else {

						// This is a command so resolve it now.
						defered.resolve(true)
					}

					// Tell the queue that we are finished with this task
					done()
				}
			})

			// Return the promise but if resolved return only the content
			return defered.promise.then(function(res){ 
				return ack? res.content : res 
			})
		}
		catch(error) {
			// If we get here there probably was a programming error
			this.log.error({func:'invoke.remote', msg:'error', error})
			throw error
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
	try {
		let sub = new Action(config)
		this._subscriptions[sub.id] = sub
		this.log.info({func:'subscribe', msg:'registered', name})
	}
	catch(error) {
		// There probably was an error registering the subscription
		this.log.error({func:'subscribe', msg:'error', name, error})
		this._registrationErrors.push(name)
	}
	finally {
		// Make sure we can continue in the event of an error
		return this
	}
}


/**

 Publish something on the topic exchange

 @method
 @param   {string}   topic   - the topic on which to publish
 @param   {mixed}    content - the content to publish

 @returns {Promise} that command has been issued.

 */

Service.prototype.publish = function publish(topic, content) {

	var ex   = this._options.exchangeTopic,
		self = this

	return new Promise(function(resolve, reject){
	
		// Log that the publish command is being queued
		self.log.info({func:'publish', msg:'queued', topic})

		// Queue it and it will get executed once connected
		self._queue.push({
			work: function(done) {
				try {
					// Log the actual publishing and send the message
					self.log.info({func:'publish', msg:'run', exchange:ex, topic, content})
					self._channel.publish(ex, topic, new Buffer(JSON.stringify(content)))
					resolve(true)
					done()
				}
				catch(error) {
					// If we reach this point there was probably a programming error
					// Or perhaps we were disconnected a moment ago.
					reject(error)
				}
			}
		})
	})		
}




/**

 Puts the script on a queue for execution.

 This is essentially a wrapper around co that allows you to invoke services and 
 issue commands. It makes it easy to write quick scripts to test ideas.

 @method
 @param   {function} generatorFunc - script to execute
 
 @returns {Promise} that the script will get executed.

 */

Service.prototype.script = function script(generatorFunc) {

	var context = createContext.call(this)

	return new Promise(function(resolve, reject){

		this._queue.push({
			work: function(done){
				co(generatorFunc.bind(context)).then(resolve, reject)
				done() // We don't wait for the script to finish
			}
		})
	})
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
			self.log.info({func:'register', msg:'action', name})
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
				self.log.info({func:'register', msg:'subscription', topic, subId})
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

				try {
					// Run the action along with the middleware
					var res = yield action.run(self._middleware, context)
				}
				catch(error) {
					// If we get here we have a programming error!
					self.log.error({func:'consumer', msg:'error', error})
					this.res = {error$: error}
				}

				// If there is a result then set the context to that result
				if (res !== undefined) context.res = res

				// Reply the response if we have a replyTo address
				var replyTo = message.properties.replyTo

				if (replyTo) {
					var correlationId = message.properties.correlationId
					var buffer = new Buffer(JSON.stringify(context.res || 'ok'))
					channel.sendToQueue(replyTo, buffer, {correlationId})
				}
			}
			catch(error) {
				// If we get here we have a programming error!
				self.log.error({func:'consumer', msg:'error', error})
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
	context.sleep    = this.sleep.bind(this)
	context.log      = this.log

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

