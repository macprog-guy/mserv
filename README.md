# Introduction

Mserv is a thin [koa](http://koajs.com)-style wrapper around [amqplib](http://www.squaremobius.net/amqp.node/doc/channel_api.html) to facilitate the creation of microservices communicating through an AMQP message broker. It also applies some excellent ideas taken from [hapi.js](http://hapijs.com).

# Quick start

## Installation

    npm i --save mserv

## Note

Because we use generators and a bit of es6 syntax the `--harmony` flag must be used.


## Example

```js
// --------------------------------------------------------
// Server
// --------------------------------------------------------

var service = require('mserv')()
.action({
	name: 'example.adder',
	handler: function*(){
        x = this.req.x
        y = this.req.y
        return x + y
    }
})

// --------------------------------------------------------
// Client
// --------------------------------------------------------

var service = require('mserv')(),
    co = require('co')

co(function*(){
	var sum = yield service.invoke('example.adder', {x:12, y:7})
	console.log('sum = ' +  sum)
	service.close()
})

// sum = 19
```

## Documentation

Read the [API documentation](API.md) for the details.


## Actions

Actions are the heart of mserv. They are essentially named function handlers.
The handlers themselves are implemented with generator functions. This makes 
it easy to call other microservices or promise returning code in a manner 
that reads almost like sequential code. 

Here is an example simple "echo" microservice:

```js
service.action({
	name: 'echo',
	handler: function*(){
		// If the return value is not undefined it gets assigned to this.res
        return this.req
    }
})
```

Actions are not executed in the dark. They are bound to a context object 
with the following keys:

- `headers$` : the AMQP message.properties
- `amqp$`    : the AMQP message.fields
- `req`      : the AMQP message.content
- `res`      : the response and initially an empty object

- `service`  : the service itself
- `invoke`   : a shortcut to service.invoke.
- `command`  : a shortcut to service.command
- `publish`  : a shortcut to service.publish
- `log`      : a shortcut to service.log a bunyan logger
- `sleep`    : a shortcut to service.sleep



## Middleware

Mserv got inspiration from both [koa](http://koajs.com) and [hapi.js](http://hapijs.com)
for it's middleware pipeline. From koa we use the idea of using generator functions that 
yield down the middleware chain. From hapi we use the idea that middleware is instantiable
and configurable.

Here is an example of timing middleware:

```js

// --------------------------------------------------------
// Middleware
// --------------------------------------------------------

var middleware = function(service, globalOptions) {

	return function*(next, actionOptions) {

		var startTime = new Date()
		yield next
		var endTime = new Date()
		console.log('['+actionOption.action+'] ' + (endTime-startTime) + 'ms')
	}
}

// --------------------------------------------------------
// Usage
// --------------------------------------------------------

var service = require("mserv")(),
	co = require('co')

service
.use('timer', middleware, {/* globalOptions */})
.action({
	name: 'example.slowAdder',
	timer: { /* actionOptions */ }
	handler: function*(){
        x = this.req.x
        y = this.req.y
        yield this.service.sleep(Math.random() * 100)
        return x + y
    }
})

co(function*(){
	var sum = yield this.invoke('example.slowAdder', {x:12, y:7})
	console.log('sum = ' +  sum)
	service.close()
})

// [slowAdder] 34ms
// sum = 19

```

## Extensions

Extensions expose additional functions through the service, which always available.
Here is a contrived example of an extension than generates multiple actions:

```js

// --------------------------------------------------------
// Extension
// --------------------------------------------------------

var extension = function(service, globalOptions) {
	
	var count = globalOptions.count || 10

	function registerAction(prefix, i) {
		service.action({
			name: prefix + '.' + i,
			handler: function*(){
				return this.req.x + i
			}
		})
	}

	return function(prefix) {
		for (var i=1;  i<=count;  i++)
			registerAction(prefix, i)
	}
}

// --------------------------------------------------------
// Usage
// --------------------------------------------------------

var service = require('mserv')(),
	co      = require('co')

service.extend('adders',extension, {count:9})

service.ext.adders('slow.incr')

co(function*(){
	var x = 0
	x = yield this.invoke('slow.incr.3',{x:x})
	console.log('x = ' + x)
	x = yield this.invoke('slow.incr.9',{x:x})
	console.log('x = ' + x)
})

// x = 3
// x = 12

```


## Commands

At times we don't really care about the result of some invocation.
In these case what we want is to use the `command` instead of `invoke`.
In the background `command` calls `invoke` but in such a way that the 
caller won't wait around for a reply from the microservice provider.
In fact the provider won't send a reply because the message won't contain
a replyTo queue name nor any correlationId.

```js

co(function*(){
	this.command('mailer.sendFromTemplate', {email:'email@domain.com', template:'signup'})
})

```


## Publish/Subscribe

At times we may want to use topical queues instead of direct exchanges.
This is often the case with logs for example. It's just as easy to implement
microservices using a topic exchange. Furthermore, messages arriving 
through a topic exchange still go through the same middleware pipeline.
Unlike actions, you can have multiple listeners on the same topic.

```js

var service = require('mserv')()
.subscribe({
	name: 'logs',
	handler: function*() {
		console.log(JSON.stringify(this.req))
	}
})

co(function*(){
	this.publish('logs', 'foo')
	this.publish('logs', 'bar')
})

```




# License

The MIT License (MIT)

Copyright (c) 2015 Eric Methot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
	