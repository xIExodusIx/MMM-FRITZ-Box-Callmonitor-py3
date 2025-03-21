"use strict";

const NodeHelper = require("node_helper");
const CallMonitor = require("node-fritzbox-callmonitor");
const vcard = require("vcard-json");
const phoneFormatter = require("phone-formatter");
const xml2js = require("xml2js");
const moment = require('moment');
const exec = require('child_process').exec;
const {PythonShell} = require('python-shell');
const path = require("path");

const CALL_TYPE = Object.freeze({
	INCOMING: "1",
	MISSED: "2",
	OUTGOING: "3",
	BLOCKED: "10"		//New entry for blocked calls as found on: https://fritzconnection.readthedocs.io/en/1.14.0/sources/library_modules.html
})
//outgoing missed calls are not in the list

module.exports = NodeHelper.create({
	// Subclass start method.
	start: function () {
		this.ownNumbers = []
		this.started = false;
		//create addressbook dictionary
		this.AddressBook = {};
		console.log("Starting module: " + this.name);
	},

	normalizePhoneNumber(number) {
		return phoneFormatter.normalize(number.replace(/\s/g, ""));
	},

	getName: function (number) {
		//Normalize number
		var number_formatted = this.normalizePhoneNumber(number);
		//Check if number is in AdressBook if yes return the name
		if (number_formatted in this.AddressBook) {
			return this.AddressBook[number_formatted];
		} else {
			//Not in AdressBook return original number
			return number;
		}
	},

	socketNotificationReceived: function (notification, payload) {
		//Received config from client
		if (notification === "CONFIG") {
			//set config to config send by client
			this.config = payload;
			//if monitor has not been started before (makes sure it does not get started again if the web interface is reloaded)
			if (!this.started) {
				//set started to true, so it won't start again
				this.started = true;
				console.log("Received config for " + this.name);

				this.parseVcardFile();
				this.setupMonitor();
			}
			//send fresh data to front end (page might have been refreshed)
			if (this.config.password !== "") {
				this.loadDataFromAPI();
			}
		}
		if (notification === "RELOAD_CALLS") {
			this.loadDataFromAPI("--calls-only");
		}
		if (notification === "RELOAD_CONTACTS") {
			this.loadDataFromAPI("--contacts-only");
		}
	},

	setupMonitor: function () {
		//helper variable so that the module-this is available inside our callbacks
		var self = this;

		//Set up CallMonitor with config received from client
		var monitor = new CallMonitor(this.config.fritzIP, this.config.fritzPort);

		//Incoming call
		monitor.on("inbound", function (call) {
			//If caller is not empty
			if (call.caller != "") {
				self.sendSocketNotification("call", self.getName(call.caller));
			}
		});
		
		monitor.on("outbound", function (call) {
			//Save own number (call.caller) to ownNumbers Array to distinguish inbound/outbound on "connected" handler
			if (!self.ownNumbers.includes(call.caller))
				self.ownNumbers.push(call.caller)
				self.sendSocketNotification("outbound", call.called);

		});
		
		//Call blocked
		monitor.on("blocked", function (call) {
				var name = call.type === "blocked" ? self.getName(call.called) : self.getName(call.caller);
				//send clear command to interface
				self.sendSocketNotification("blocked", self.getName(call.caller)); //{ "caller": name, "duration": call.duration });
		});
		
		//Call accepted
		monitor.on("connected", function (call) {
			var name = self.ownNumbers.includes(call.caller) ? self.getName(call.called) : self.getName(call.caller);
			var direction = self.ownNumbers.includes(call.caller) ? "out" : "in";
			self.sendSocketNotification("connected", { "caller": name, "direction": direction });

		});

		//Caller disconnected
		monitor.on("disconnected", function (call) {
			var name = call.type === 'outbound' ? self.getName(call.called) : self.getName(call.caller);
			//send clear command to interface
			self.sendSocketNotification("disconnected", { "caller": name, "duration": call.duration });
		});
		console.log(this.name + " is waiting for incoming calls.");
	},

	parseVcardFile: function () {
		var self = this;

		if (!this.config.vCard) {
			return;
		}
		vcard.parseVcardFile(self.config.vCard, function (err, data) {
			//In case there is an error reading the vcard file
			if (err) {
				self.sendSocketNotification("error", "vcf_parse_error");
				if (self.config.debug) {
					console.log("[" + self.name + "] error while parsing vCard " + err);
				}
				return
			}

			//For each contact in vcf file
			for (var i = 0; i < data.length; i++) {
				//For each phone number in contact
				for (var a = 0; a < data[i].phone.length; a++) {
					//normalize and add to AddressBook
					self.AddressBook[self.normalizePhoneNumber(data[i].phone[a].value)] = data[i].fullname;
				}
			}
			self.sendSocketNotification("contacts_loaded", Object.keys(self.AddressBook).length);
		});
	},

	loadCallList: function (body) {
		var self = this;

		xml2js.parseString(body, function (err, result) {
			if (err) {
				self.sendSocketNotification("error", "calllist_parse_error");
				console.error(self.name + " error while parsing call list: " + err);
				return;
			}
			var callArray = result.root.Call;
			var callHistory = []

			for (var index in callArray) {
				var call = callArray[index];
				var type = call.Type[0];
				//Trying to handle blocked calls these lines 164-171 are new from "if to else" and it works!
				if  (name = type == CALL_TYPE.BLOCKED || type == CALL_TYPE.INCOMING ? self.getName(call.Caller[0]) : self.getName(call.Called[0]));
					var duration = call.Duration[0];
					if (type == CALL_TYPE.INCOMING && self.config.deviceFilter && self.config.deviceFilter.indexOf(call.Device[0]) > -1) {
						continue;
				} 
				else
				//From here the original script is ongoing
				var name = type == CALL_TYPE.MISSED || type == CALL_TYPE.INCOMING ? self.getName(call.Caller[0]) : self.getName(call.Called[0]);
				var duration = call.Duration[0];
					if (type == CALL_TYPE.INCOMING && self.config.deviceFilter && self.config.deviceFilter.indexOf(call.Device[0]) > -1) {
						continue;
				}
				var callInfo = { "time": moment(call.Date[0], "DD.MM.YY HH:mm"), "caller": name, "type": type, "duration": duration };
				if (call.Name[0]) {
					callInfo.caller = call.Name[0];
				}
				callHistory.push(callInfo)
		}
			self.sendSocketNotification("call_history", callHistory);
		});
	},

	loadPhonebook: function (body) {
		var self = this;

		xml2js.parseString(body, function (err, result) {
			if (err) {
				self.sendSocketNotification("error", "phonebook_parse_error");
				if (self.config.debug) {
					console.error(self.name + " error while parsing phonebook: " + err);
				}
				return;
			}
			var contactsArray = result.phonebooks.phonebook[0].contact;
			for (var index in contactsArray) {
				var contact = contactsArray[index];
				var contactNumbers = contact.telephony[0].number;
				var contactName = contact.person[0].realName;

				for (var index in contactNumbers) {
					var currentNumber = self.normalizePhoneNumber(contactNumbers[index]._);
					self.AddressBook[currentNumber] = contactName[0];
				}
			}
			self.sendSocketNotification("contacts_loaded", Object.keys(self.AddressBook).length);
		});
	},

	loadDataFromAPI: function (additionalOption) {
		var self = this;

		if (self.config.debug) {
			console.log('Starting access to FRITZ!Box...');
		}

		let args = ['-i', self.config.fritzIP, '-p', self.config.password];
		if (self.config.username !== "") {
			args.push('-u');
			args.push(self.config.username);
		}
		if (additionalOption) {
			args.push(additionalOption);
		}

		let options = {
			pythonPath: 'python3',
			mode: 'json',
			scriptPath: path.resolve(__dirname),
			args: args
		};

		let pyshell = new PythonShell('fritz_access.py', options);

		pyshell.on('message', function (message) {
			if (message.filename.indexOf("calls") !== -1) {
				//Call list file
				self.loadCallList(message.content);
			} else {
				//Phone book file
				self.loadPhonebook(message.content);
			}
		});

		//End the input stream and allow the process to exit
		pyshell.end(function (error) {
			if (error) {
				var errorUnknown = true;
				if (error.traceback.indexOf("XMLSyntaxError") !== -1) {
					//Password is probably wrong
					self.sendSocketNotification("error", "login_error");
					errorUnknown = false;
				}
				if (error.traceback.indexOf("failed to load external entity") !== -1) {
					//Probably no network connection
					self.sendSocketNotification("error", "network_error");
					errorUnknown = false;
				}
				if (errorUnknown) {
					self.sendSocketNotification("error", "unknown_error");
				}
				if (self.config.debug) {
					console.error(self.name + " error while accessing FRITZ!Box: ");
					console.error(error.traceback);
				}
				return;
			}
			if (self.config.debug) {
				console.log('Access to FRITZ!Box finished.');
			}
		});
	}
});
