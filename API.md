# Table of Contents

- [mserv](#mserv)
	- [`constructor(options)`](#mserv)
	- [`connect() -> Promise`](#connect---promise)
	- [`reconnect()`](#reconnect---promise)
	- [`close()`](#close---promise)
	- [`use(String name, Function middleware [, Object options]`)](#usestring-name-function-middleware--object-options---mserv)
	- [`extend(String name, Function extension [, Object options])`](#extendstring-name-function-extension--object-options---mserv)
	- [`action(Object config) -> mserv`](#actionobject-config---mserv)
	- [`invoke(String name [, Any args] [, Object headers] [, Boolean ack]) -> Any`](#invokestring-name--any-args--object-headers--boolean-ack---any)
	- [`command(String name [, Any args] [, Object headers]) -> Boolean`](#commandstring-name--any-args--object-headers---boolean)
	- [`subscribe(Object config) -> mserv`](#subscribeobject-config---mserv)
	- [`publish(String topic [, Any args]) -> Boolean`](#publishstring-topic--any-args---boolean)
	- [`script(GeneratorFunction script) -> mserv`](#scriptgeneratorfunction-script---mserv)
	- [`sleep(Number milliseconds) -> Number`](#sleepnumber-milliseconds---number)
	- [`register() -> Promise`](#register---promise)

<hr>
##### `constructor(options)`

There is only one entry point into mserv and that's the exported constructor.
The following options are used when creating an instance of mserv.

- `amqp`: 
URL of the AMQP server or by default amqp://localhost.

- `callbackQueue`: 
Name of the callback queue. By default the name of the callback queue is a random uuid.

- `exchangeDirect`: 
Services are normally invoked using a direct type of exchange. The default name is 'services', which it makes it clear that it's made for calling services.

- `exchangeTopic`: 
Services can both listen and publish on topical exchanges. The default name is 'exchange'.

- `reconnectAttempts`: 
If the connection cannot be established then the service will try to reconnect at regular intervals. The default is 10.

- `reconnectDelay`: 
The number of milliseconds to wait between reconnect attempts. The default is 2000.

- `disableAMQPBypass`: 
When true AMQP connection will always be used when invoking services even when the reside within the same process and could be called directly. The default value is false.

- `disableAutoconnect`: 
When true the service won't automatically connect upon creation. The connection will need to be established manually. The default value is false.





<hr>
##### `connect() -> Promise`

Manually connect to the AMQP server without regards for reconnect options.
```js
service.connect().then(function(connection){
	// Do something here...
})
```




<hr>
##### `reconnect() -> Promise`

Manually reconnect to the AMQP server taking into account the reconnect options. The promise is resolved when a connection is established or rejected after a number of failed reconnect attempts.

```js
service.reconnect().then(function(connection){
	// Do something here...
})
```




<hr>
##### `close() -> Promise`

Manually close the connection to the AMQP server. This will also prevent any messages from being sent to remote microservices (local services still work). Remote requests will get queued and sent once the connection is re-established. Calling `close` manually will not trigger an automatic reconnect. If the connection is not yet established then the `close` request gets queued and will be executed after the connection is established.

```js
service.close().then(function(){
	// Do something here...
})
```




<hr>
##### `use(String name, Function middleware [, Object options] -> mserv`

Registers a middleware function with the service. Middleware functions can be registered multiple times and with different options if needed. The `name` need not be unique but middlewares with the same name will share action-level options.

The name under which the middleware is registered will determine the key that is used for action-level options. In the example below, the middleware is registeder using the 'logger' name, which means that actions that declare a logger key in their configuration will have that value passed to the generator function. In addition, the `action` key is always available in the action-level options when options is an object.

The function returns `this` to facilitate the chaining of calls.

```js

var logger = function(service) {

	return function*(next, options) {
		var startTime = new Date()
		yield next
		var endTime = new Date(),
		    elapsed = endTime - startTime
		console.log('['+options.action+'] ' + elapsed + 'ms -> ' + JSON.stringify(this.req))
	}
}

service.use('logger', logger)
```




<hr>
##### `extend(String name, Function extension [, Object options]) -> mserv`

Exposes a user defined function through the service, which is available to all actions and clients. The following example (details are left as an excercise to the reader) is an extension that provides CRUD actions from a simple configuration. Note: extensions are functions that return plain functions (as opposed to generator functions). Exposed functions are available through the `ext` property of the service.

```js

var extension = function(service, options) {
	
	var database = options.database

	return function(options) {
		
		var entity = options.name

		if (options.create) {
			service.action({
				name: entity + '.create',
				handler: function*() {
					entity = yield /* insert into the database */
				}
			})			
		}

		if (options.read) {
			service.action({
				name: entity + '.fetch',
				handler: function*() {
					entity = yield /* select from the database */
					return entity
				}
			})				
		}

		if (options.update) {
			service.action({
				name: entity + '.update',
				handler: function*() {
					entity = yield /* update record in the database */
					return entity
				}
			})				
		}

		if (options.delete) {
			service.action({
				name: entity + '.delete',
				handler: function*() {
					entity = yield /* delete record in the database */
					return 'ok'
				}
			})				
		}
	}
}

service.extend('entity', extension, {database:pgPromise})

service.ext.entity({
	name:  'users',
	table: 'auth.users',
	keys:  {id:'uuid', email:'text'},
	create: true,
	read: true,
	update: true,
	delete: true
})

co(function*(){
	
	user = yield service.invoke('users.fetch', {id:123456789})
	user.lastName = 'foo'
	user.age = 32

	user = yield service.invoke('users.update', user)
})

```




<hr>
##### `action(Object config) -> mserv`

Creates a named action handler. The configuration must contain at least the `name` and `handler` properties. Anyother keys are assumed to be middleware configuration keys.

- `name`: name under which the action is registered (reverse DNS notation is nice here).
- `handler`: a generator function that is not required to yield anything. 

During execution, the handler is bound to a context object with the following keys:

- `headers$` : is the AMQP message.properties
- `amqp$`    : is the AMQP message.fields
- `req`      : is the AMQP message.content
- `res`      : is the response and initially an empty object

- `service`  : is the service itself
- `invoke`   : is a shortcut to service.invoke.
- `command`  : is a shortcut to service.command
- `publish`  : is a shortcut to service.publish


```js
service.action({
	
	name: 'adder',
	
	description: 'takes x and y and returns x + y',
	
	// Assuming we have a 'auth' middleware that understands this
	// NOTE: because the value is not an object, the action name won't be available to the middleware.
	auth: false

	// Assuming we have a 'validate' middleware that understands this
	validate: {
		request: {
			x: 'number',
			y: 'number'
		},
		response: 'number'
	},

	handler: function*(){
		return this.req.x + this.req.y
	}
})
```




<hr>
##### `invoke(String name [, Any args] [, Object headers] [, Boolean ack]) -> Any`

Invokes a microservce (local or remote) with the given name and arguments. If the service is determined to be local then the AMQP server will be bypassed unless the disableAMQPBypass option was set.

- `name`: name of the microservice to invoke.
- `args`: optional arguments that are passed to the microservice. This becomes this.req in the handler and should be JSON serializable.
- `headers`: optional object merged into the AMQP message headers. 
- `ack`: optional flag indicating if we should wait for a response or not. Default to true.

```js

var jpgImage = service.invoke('image.convert.toJPG',image,{contentType:'image/png'})

```




<hr>
##### `command(String name [, Any args] [, Object headers]) -> Boolean`

Invokes a microservice with the given name and arguments but does not wait for a response. In fact, the action won't reply because no `replyTo` and `correlationId` headers will have been set. This is just a special case of the `invoke` function.





<hr>
##### `subscribe(Object config) -> mserv`

Subscribes to a topic on a topical exchange essentially implementing a microservice using pub/sub. The difference with pub/sub is that they currently don't support replies. The subscribers messages go through the same middleware pipeline as actions. 

`config` should have the at least the following keys:

- `name`: topic to which we should subscribe. AMQP wild cards are fine here.
- `handler`: generator function to handle incoming messages.

Other keys are assumed to be middleware configuration.

```js
service.subscribe({
	name: 'logs',
	handler: function*() {
		console.log(JSON.stringify(this.req))
	}
})
```



<hr>
##### `publish(String topic [, Any args]) -> Boolean`

Publishes a message on a topical exchange.

- `name`: topic to publish the message to.
- `args`: optional arguments that are passed to the microservice. This becomes this.req in the handler and should be JSON serializable.

For the moment, publish does not wait for responses and return true.


```js
service.publish('logs', 'Hello from mserv')
})
```



<hr>
##### `script(GeneratorFunction script) -> mserv`

Thin wrapper around co to execute in an empty context. The script will only get executed once the connection has been established. Until then it's only queued.

```js
service.script(function*(){
	sum = this.invoke('adder', {x:4, y:19})
	this.publish('logs', 'sum is '+sum)
})
```



<hr>
##### `sleep(Number milliseconds) -> Number`

Convenience function in testing functions to delay execution by a number of milliseconds.

```js
co(function*(){
	yield service.sleep(100)
})
```




<hr>
##### `register() -> Promise`

Registers all actions and subscriptions that have not yet been registered with the AMQP server. Normally this function is called by [`connect`](#connect---promise) but might be called manually should you declare actions dynamically after the initial connection has been established.


```js

// Assuming the service is already connected
service.action({
	name: 'multiplier',
	handler: function*(){
		return this.req.x * this.req.y
	}
}).register()

```






























