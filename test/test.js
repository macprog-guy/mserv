'use strict'

var chai   = require('chai'),
	should = chai.should(),
	mserv  = require('..'),
	co     = require('co'),
	_      = require('lodash')



// Helper function makes tests less verbose
function wrappedTest(generatorFunc) {
	return function(done) {
		try {
			co(generatorFunc)
			.then(
				function()   { done()    },
				function(err){ done(err) }
			)
		}
		catch(err) {
			done(err)
		}
	}
}





describe('mserv', function(){

	it('should automatically connect to the AMQP server', wrappedTest(function*(){

		let service = mserv()
		yield service.sleep(250)
		should.equal(service._state, 'ready')

	})) 


	it('should fail to connect to the AMQP server', wrappedTest(function*(){

		let service = mserv({amqp:'amqp://localhost:9999', reconnectAttempts:2})
		yield service.sleep(1000)
		should.not.equal(service._state, 'ready')
	}))


	it('actions should still be invokable locally when not connected', wrappedTest(function*(){

		var array = []
		var service = mserv({amqp:'amqp://localhost:9999', reconnectAttempts:0})
		service.action({
			name:'test', 
			handler: function*(){
				array.push(this.req)
			}
		})

		yield service.invoke('test', 1)
		yield service.invoke('test', 2)
		yield service.invoke('test', 3)

		array.should.eql([1,2,3])
	}))


	it('should invoke actions through AMQP when forced to', wrappedTest(function*(){


		var service = mserv({reconnectAttempts:0, disableAMQPBypass:true})
		service.action({
			name:'sum', 
			handler: function*(){
				let x = this.req.x,
				    y = this.req.y
				return x + y
			}
		})

		let sum1 = yield service.invoke('sum', {x:3, y:9}),
			sum2 = yield service.invoke('sum', {x:1, y:29}),
			sum3 = yield service.invoke('sum', {x:8, y:8})

		sum1.should.equal(12)
		sum2.should.equal(30)
		sum3.should.equal(16)
	}))


	it('should receive messages from topic exchange', wrappedTest(function*(){

		var service = mserv(),
			array   = []

		service.subscribe({
			name: 'test.foo',
			handler: function*(){
				array.push(this.req)
			}
		})

		service.publish('test.foo', 'a')
		service.publish('test.foo', 'b')
		service.publish('test.foo', 'c')
		yield service.sleep(500)

		array.should.eql(['a','b','c'])
	}))


	it('should run the middleware as expected', wrappedTest(function*(){

		var service = mserv(),
			array   = []

		var middleware = function(service, options) {
			var m = options.m || 1
			return function*(next, options) {
				try {
					this.req *= m
					yield next
					this.res = this.res + options.b || 0
				}
				catch(err) {
					console.error(err)
					console.error(err.stack)
				}
			}
		}

		service
		.use('multiplier', middleware, {m:20})
		.action({
			name: 'test.mxb',
			multiplier: {b: 1},
			handler: function*(){
				return this.req / 2
			}
		})

		var res1, res2, res3

		res1 = yield service.invoke('test.mxb', 1)
		res2 = yield service.invoke('test.mxb', 2)
		res3 = yield service.invoke('test.mxb', 3)

		should.equal(res1, 11)
		should.equal(res2, 21)
		should.equal(res3, 31)
	}))

	it('should forward errors properly', wrappedTest(function*(){

		var service = mserv()

		service.action({
			name: 'throw',
			handler: function*(){
				let err = new Error('Test Error')
				err.payload = {a:3, b:undefined}
				throw err
			}
		})

		try {
			yield service.invoke('throw')
			throw new Error('Invoke did not throw')
		}
		catch(err) {
			if (err.message === 'Invoke did not throw')
				throw err 

			err.name.should.equal('Error')
			err.message.should.equal('Test Error')
			err.payload.should.eql({a:3, b:undefined})
		}

	}))


	it('should not raise an exception when returning null', wrappedTest(function*(){

		var service = mserv()

		service.action({
			name: 'noop',
			handler: function*(){
				return null
			}
		})

		yield service.invoke('noop')
	}))
})