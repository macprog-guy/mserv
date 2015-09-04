chai    = require('chai')
Service = require('../lib/service')
_       = require('lodash')
should  = chai.should()
co      = require('co')


describe('mserv', function(){

	it('should automatically connect to the AMQP server', function(done){

		var service = Service()

		setTimeout(function(){
			try {
				should.equal(service._state, 'ready')
				done()
			} 
			catch(err) { 
				done(err) 
			}
		}, 250)
	})


	it('should fail to connect to the AMQP server', function(done){

		var service = Service({amqp:'amqp://localhost:9999', reconnectAttempts:2})
		setTimeout(function(){
			try {
				should.not.equal(service._state, 'ready')
				done()
			} 
			catch(err) { 
				done(err) 
			}
		}, 1000)
	})


	it('actions should still be invokable locally when not connected', function(done){

		try {
			var array = []
			var service = Service({amqp:'amqp://localhost:9999', reconnectAttempts:0})
			service.action({
				name:'test', 
				handler: function*(){
					array.push(this.req)
				}
			})

			co(function*(){
				yield service.invoke('test', 1)
				yield service.invoke('test', 2)
				yield service.invoke('test', 3)
			}).then(function(){
				array.should.eql([1,2,3])
				done()				
			})

		}
		catch(err) {
			done(err)
		}
	})


	it('should invoke actions through AMQP when forced to', function(done){


		try {
			var service = Service({reconnectAttempts:0, disableAMQPBypass:true})
			service.action({
				name:'sum', 
				handler: function*(){
					x = this.req.x
					y = this.req.y
					return x + y
				}
			})

			co(function*(){
				sum1 = yield service.invoke('sum', {x:3, y:9})
				sum2 = yield service.invoke('sum', {x:1, y:29})
				sum3 = yield service.invoke('sum', {x:8, y:8})
			}).then(function(){
				sum1.should.equal(12)
				sum2.should.equal(30)
				sum3.should.equal(16)
				done()				
			})

		}
		catch(err) {
			done(err)
		}
	})


	it('should receive messages from topic exchange', function(done){

		try {
			var array = []
			var service = Service()

			service.subscribe({
				name: 'test.foo',
				handler: function*(){
					array.push(this.req)
				}
			})

			co(function*(){
				service.publish('test.foo', 'a')
				service.publish('test.foo', 'b')
				service.publish('test.foo', 'c')
			})

			setTimeout(function(){
				array.should.eql(['a','b','c'])
				done()
			}, 500)

		}
		catch(err) {
			done(err)
		}
	})


	it('should run the middleware ware correctly', function(done){

		try {
			var array = []
			var service = Service()

			plugin = function(service, options) {
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
			.use('multiplier', plugin, {m:20})
			.action({
				name: 'test.mxb',
				multiplier: {b: 1},
				handler: function*(){
					return this.req / 2
				}
			})

			var res1, res2, res3

			co(function*(){

				res1 = yield service.invoke('test.mxb', 1)
				res2 = yield service.invoke('test.mxb', 2)
				res3 = yield service.invoke('test.mxb', 3)

				should.equal(res1, 11)
				should.equal(res2, 21)
				should.equal(res3, 31)
				done()
			})

		}
		catch(err) {
			done(err)
		}
	})
})