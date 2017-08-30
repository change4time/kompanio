const functions = require('firebase-functions');
const admin = require('firebase-admin');

const cors = require('cors')({origin: true});
const gcs = require('@google-cloud/storage')();
const exec = require('child-process-promise').exec;
const spawn = require('child-process-promise').spawn;
const mkdirp = require('mkdirp-promise');
const moment = require('moment');
const crypto = require('crypto');

const express = require('express');
const router = new express.Router();

const UNIVERSAL_DATE = 0;
const UNIVERSAL_REVENUE = 0;
const UNIVERSAL_TAX = 0;

const LOCAL_TMP_FOLDER = '/tmp/';
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
const THUMB_PREFIX = 'thumb_';
const JPEG_EXTENSION = 'jpg';

const BUCKET_NAME = 'bank4time.appspot.com';
const PHOTOS_DIR = 'photos/';
const PHOTO_PATH = PHOTOS_DIR+'${key}.jpg';
const THUMB_PHOTO_PATH = PHOTOS_DIR+THUMB_PREFIX+'${key}.jpg';
const IMAGE_URL = 'https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${path}?alt=media';

const SECURE_AMOUNT_MIN = 5 * 3600 * 1000;

admin.initializeApp(functions.config().firebase);
const db = admin.database();

// Express middleware that validates Firebase ID Tokens passed in the Authorization HTTP header.
// The Firebase ID token needs to be passed as a Bearer token in the Authorization HTTP header like this:
// `Authorization: Bearer <Firebase ID Token>`.
// when decoded successfully, the ID Token content will be added as `req.user`.
const validateFirebaseIdToken = (req, res, next) => {
  console.log('Check if request is authorized with Firebase ID token');

  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
    console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.',
        'Make sure you authorize your request by providing the following HTTP header:',
        'Authorization: Bearer <Firebase ID Token>');
    res.status(403).send('Unauthorized');
    return;
  }
  const idToken = req.headers.authorization.split('Bearer ')[1];
  admin.auth().verifyIdToken(idToken).then(decodedIdToken => {
    console.log('ID Token correctly decoded', decodedIdToken);
    req.user = decodedIdToken;
    next();
  }).catch(error => {
    console.error('Error while verifying Firebase ID token:', error);
    res.status(403).send('Unauthorized');
  });
};

const flowTo = (flow, nb) => {
	let to = {
		amount: flow.amount,
		account: flow.from.id ? flow.from.id : 'KOMPANIO-NETWORK',
		by: flow.by,
		name: flow.from.name,
		label: flow.to.label,
		start: flow.start
	};
	if(nb) {
		to.amount *= nb;
		to.nbAccount = nb;
	}
	return to;
}

const flowFrom = (flow, nb) => {
	let from = {
		amount: -flow.amount,
		account: flow.to.id ? flow.to.id : 'KOMPANIO-NETWORK',
		by: flow.by,
		name: flow.to.name,
		label: flow.from.label,
		start: flow.start
	};
	if(nb) {
		from.amount *= nb;
		from.nbAccount = nb;
	}
	return from;
}

const executeFlowTransaction = (flowId, flow) => {
	return new Promise((resolve, reject) => {
		let updates = {};
		if(flow.from.id && flow.to.id) {
			updates['accounts/'+flow.from.id+'/flows/'+flowId] = flowFrom(flow, null);
			updates['accounts/'+flow.to.id+'/flows/'+flowId] = flowTo(flow, null);
			resolve(updates);
		} else {
			let accountId = flow.from.id ? flow.from.id : flow.to.id;
			if(!accountId) {
				console.error("From and To accounts can't be null");
			} else {
				db.ref('accounts/'+accountId+'/members').once('value', function(snap) {
					const members = snap.val();
					let nb = 0;
					for(let bcAccount in members) {
						updates['accounts/'+bcAccount+'/flows/'+flowId] = flow.from.id ? flowTo(flow, null) : flowFrom(flow, null);
						nb++;
					}
					updates['accounts/'+accountId+'/flows/'+flowId] = flow.from.id ? flowFrom(flow, nb) : flowTo(flow, nb);
					resolve(updates);
				});
			}
		}
	});
}

/**
*	Generate a hash code for string
*/
function hash(str) {
    var hash = 0;
    if (str.length == 0) return hash;
    for (i = 0; i < str.length; i++) {
        char = str.charCodeAt(i);
        hash = ((hash<<5)-hash)+char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
}

/*
* Compute the new account balance for this payments set
*
*/
function compute(now, account, payments) {
	/* Reset ongoing payments */
	account.ongoing.income = 0;
	account.ongoing.expense = 0;
	account.ongoing.balance = 0;
	for(payment of payments) {
		let amount = 0;
		let start = moment.utc(payment.start);
		let end = payment.end != null ? moment.utc(payment.end) : now;
		if(start.isSameOrBefore(account.ongoing.updated) && end.isAfter(account.ongoing.updated)) {
			amount = end.diff(account.ongoing.updated) * payment.speed;
		} else if(start.isAfter(account.ongoing.updated) && end.isSameOrBefore(now)) {
			amount = end.diff(start) * payment.speed;
		}
		console.log("COMPUTE - %s to %s : %d", start.format("YYYY-MM-DD HH-mm-ss"), end.format("YYYY-MM-DD HH-mm-ss"), amount);
		/* Update current account balance */
		if(amount > 0) {
			account.current.income += amount;
		} else {
			account.current.expense += amount;
		}
		account.current.balance += amount;

		/* Update ongoing account balance */
		if(end.isSame(now)) {
			if(payment.speed > 0) {
				account.ongoing.income += payment.speed;
			} else {
				account.ongoing.expense += payment.speed;
			}
			account.ongoing.balance += payment.speed;
		}
	}
	account.ongoing.updated = now.valueOf();
	account.current.updated = now.valueOf();
	return account;
}

/**
*	Move a file
*/
function move(filePath, destPath) {
	//const destPath = destDir + filePath.split('/').pop();
	return gcs.bucket(BUCKET_NAME).file(filePath).move(destPath, function(err, destinationFile, apiResponse) {
		console.log(destinationFile);
		console.log(apiResponse);
		if(err)
			console.log('Error ' + err.code + ':' + err.message);
	});
}

function photoURL(id) {
	return IMAGE_URL.replace('${bucket}', BUCKET_NAME).replace('${path}', encodeURIComponent(THUMB_PHOTO_PATH.replace('${key}', id)));
}

function authorizePayment(payment) {
	return new Promise((resolve, reject) => {
		if(payment.amount <= 0) {
					reject('bad_amount');
		} else {
			if(payment.authorization.type == 'card') {
				db.ref('cards/' + payment.authorization.card).once('value', function(snapCard) {
					const card = snapCard.val();
					/* Check token */
					if(card == null) {
						reject('invalid_card_id');
					} else if(!card.valid) {
						reject('card_blacklisted');
					} else {
						if(payment.authorization.signature) {
							let message = payment.authorization.card+':'+payment.to.id+':'+payment.amount;
							let verify = crypto.createHmac('sha256', ''+card.secret).update(message).digest('base64');
							if(verify != payment.authorization.signature) {
								console.error('Signature mismatch ', payment.authorization.signature, verify);
								return reject('bad_signature');
							}
						} else if(payment.amount > SECURE_AMOUNT_MIN) {
							return reject('missing_signature');
						}
				
						/* Verify recipient account */
						db.ref("accounts/" + payment.to.id + "/state").once("value", function(snapTo) {
							const toAccount = snapTo.val();
							if(toAccount == null) {
								reject('bad_recipient');
							} else {
								if(toAccount.type == "personal") {
									const currentIncome = toAccount.current.income + (toAccount.ongoing.income * moment().diff(moment(toAccount.ongoing.updated)));
									const maxIncome = moment().diff(moment(toAccount.created));
									if(maxIncome != null && currentIncome > maxIncome) {
										reject('recipient_quota_exceed');
										return;
									}
								}
				
								/* Verify emitter account */
								db.ref("accounts/" + card.account.id + "/state").once("value", function(snapFrom) {
									const fromAccount = snapFrom.val();
									if(fromAccount == null) {
										reject('bad_card_account');
									} else if((fromAccount.balance - payment.amount) < 0) {
										reject('insufisiant_funds');
									} else {
										resolve(card);
									}
								});
							}
						});
					}
				});// Card ref
			} else {
				reject('bad_auth_type');
			}
		} // If amount
	});//Promise
}

/****************************************/
/*****                              *****/
/*****           Exports            *****/
/*****                              *****/
/****************************************/

/**
*	Serve user image profile
*/
exports.photo = functions.https.onRequest((request, response) => {
	response.redirect(photoURL(request.query.key));
});

exports.createUser = functions.https.onRequest((request, response) => {
	console.log("Create user : ", request.body);
	const email = request.body.email;
	const password = request.body.password;
	const data = request.body.data;
	data.identity.lastName = data.identity.lastName.toUpperCase();
	const name = data.identity.firstName + ' ' + data.identity.lastName;
	const created = moment.utc(data.identity.birthDate);
	const uid = created.format('YYYYMMDD-HHmmss') + '-' + hash(name);
	return admin.auth().createUser({
		uid: uid,
		email: email,
		password: password,
		displayName: name,
		photoURL: data.photoURL,
		disabled: true
	}).then(function(userRecord) {
		console.log("Successfully created new user:", userRecord.uid);
		db.ref("users/" + uid).set(data, function(error) {
  		if (error) {
    		console.log("Data could not be saved." + error);
    		response.status(500).send(error);
  		} else {
   			console.log("Data saved successfully.");
   			response.status(200).send(data);
   			// TODO : Notify admin for moderation
  		}
		});
	}).catch(function(error) {
		console.log("Error creating new user: ", error);
		response.status(500).send(error);
	});
});

/**
*	Approve a pending user
*/
exports.approveUser = functions.https.onRequest((request, response) => {
	return admin.auth().getUser(request.query.uid).then(function(userRecord) {
		let birthdate = userRecord.uid.split('-').shift();
		const created = moment.utc(birthdate);
		const now = moment.utc();
		
		/* User account */
		let account = {
			state: {
				type: 'personal',
				created: created.valueOf(),
				current: {
					balance: 0,
					expense: 0,
					income: 0,
					updated: created.valueOf()
				},
				ongoing: {
					balance: 0,
					expense: 0,
					income: 0,
					updated: created.valueOf(),
					nextUpdate: now.valueOf()
				}
			},
			flows: {}
		};
		
		return db.ref('flows').orderByChild("to/id").equalTo(null).once("value", function(snap) {
			snap.forEach(function(data) {
    		console.log("Add " + data.key + " flow to new user");
    		account.flows[data.key] = flowTo(data.val(), null);
  		});
			
			/* Create account */
			console.log("Creating account : ", account);
			return db.ref('accounts/' + userRecord.uid).set(account, function(error) {
				if (error) {
					console.log(error);
					response.status(500).send(error);
				} else {
					console.log('Account %s successfully created', userRecord.uid);
					admin.auth().updateUser(userRecord.uid, {
						photoURL: 'https://profile.kompanio.net/'+userRecord.uid+'/photo',
						disabled: false
					}).then(function(userRecord) {
						response.status(200).send("User successfully created");
						// TODO : Notify users
					}).catch(function(error) {
						console.log("Error updating user:", error);
						response.status(500).send(error);
					});
				}
			}); //update
		}); //universal
	}); // getUser
});

/**
*	Approve a pending group
*/
exports.approveGroup = functions.https.onRequest((request, response) => {
	const gid = request.query.gid;
	return db.ref('/groups/'+gid).once("value", function(snap) {
		const group = snap.val();
		const now = moment.utc();
		
		/* User account */
		let account = {
			state: {
				type: 'public',
				created: now.valueOf(),
				current: {
					balance: 0,
					expense: 0,
					income: 0,
					updated: now.valueOf()
				},
				ongoing: {
					balance: 0,
					expense: 0,
					income: 0,
					updated: now.valueOf(),
					nextUpdate: now.valueOf()
				}
			},
			delegations: {}
		};
		account.delegations[group.owner.id] = {
			name: group.name,
			delegate: group.owner.name,
			manage: true,
			read: true,
			pay: true,
			collect: true,
		};
		
		/* Create account */
		console.log("Creating account : ", account);
		return db.ref('accounts/' + gid).set(account, function(error) {
			if (error) {
				console.log(error);
				response.status(500).send(error);
			} else {
				console.log('Account %s successfully created', gid);
				response.status(200).send("User successfully created");
				// TODO : Notify users
			}
		}); //update
	}); // groups
});

exports.cardInfo = functions.https.onRequest((request, response) => {
  // Retrieve payment card
  var cardId = request.query.id;
  if(cardId == null) {
        response.status(404).send("Bad card id");
  } else {
  	db.ref("cards/"+cardId).once("value", function(snap) {
			var card = snap.val();
			if(card == null) {
				response.status(404).send("Unknown card " + cardId);
			} else {
				card.id = cardId;
				response.status(200).send(card.account);
			}
		});
  }
});

/**
*	Register delegation for concerned user
*/
exports.delegations = functions.database.ref('accounts/{accountId}/delegations/{userId}').onWrite(event => {
	const delegation = event.data.val();
	const accountId = event.params.accountId;
	const userId = event.params.userId;
	
	return db.ref('users/'+userId+'/delegations/'+accountId).set(delegation, function(error) {
		if (error) {
			console.log("Fail to set delegation ", error);
		} else {
			// TODO : Notify users
		}
	});
});
    
/**
*	Process an incoming payment
*/
exports.processPayment = functions.database.ref('payments/{paymentId}').onWrite(event => {
	// Grab the current value of what was written to the Realtime Database.
	const payment = event.data.val();
	const paymentId = event.params.paymentId;
	
	if(!payment) {
		return null;
	}
	
	/* Payment need an authorization */
	if(payment.from.id == null) {
		return authorizePayment(payment).then((card) => {
			let update = {
				'from/id': card.account.id,
				'from/name': card.account.name,
				'by': card.older
			};
			return db.ref('payments/'+paymentId).update(update, function(error) {
				if (error) {
					console.log("Fail to update from account ", error);
				}
			});
		}, (error) => {
			console.log("Authorization processing failure ", error);
		});
	
	/* Payment not executed yet */
	} else {
		console.log("Save payments ", payment);	
		let from = {
			created: payment.created,
			amount: -payment.amount,
			account: payment.to.id,
			by: payment.by,
			name: payment.to.name,
			label: payment.from.label
		};
	
		let to = {
			created: payment.created,
			amount: payment.amount,
			account: payment.from.id,
			by: payment.by,
			name: payment.from.name,
			label: payment.to.label
		};
	
		let updates = {};
		updates['accounts/'+payment.from.id+'/payments/'+paymentId] = from;
		updates['accounts/'+payment.to.id+'/payments/'+paymentId] = to;
		return db.ref().update(updates, function(error) {
			if (error) {
				console.log("Fail to store payments ", error);
			}
		});
	}
});

exports.updateBalance = functions.database.ref('accounts/{accountId}/payments/{paymentId}').onWrite(event => {
	const payment = event.data.val();
	const accountId = event.params.accountId;
	const paymentId = event.params.paymentId;

	let amount = payment.amount;
	if (event.data.previous.exists()) { // Update
		const old = event.data.previous.val();
		amount -= old.amount;
	}
	
	if(amount != 0) {
		return db.ref("accounts/"+accountId+"/state").transaction(function (account) {
			if(account == null)
					return null;
			if(amount > 0)
				account.current.income += amount;
			else
				account.current.expense += amount;
			account.current.balance += amount;
			account.current.updated = new Date().getTime();
			return account;
		}, function(error, committed, snapshot) {
			if (error) {
				console.error(error);
			} else if (!committed) {
				console.error('Bad account ' + accountId);
			} else {
				console.log('Balance updated for ' + accountId);
			}
		});
	} else {
		return null;
	}
});

/**
*	Process an incoming flow
*/
exports.processFlow = functions.database.ref('flows/{flowId}').onWrite(event => {
	const flowId = event.params.flowId;
	const flow = event.data.val();
	
	if(!flow) {
		return null;
	}

	return executeFlowTransaction(flowId, flow).then((updates) => {
		console.log("Save flows ", flow);	
		return db.ref().update(updates, function(error) {
			if (error) {
				console.log("Fail to store flow ", error);
			} else {
				// TODO : Notify users
			}
		});
	}, (error) => {
		console.log("Transaction processing failure ", error);
	});
});

/**
*	Update ongoing balance if flows changes
*/
exports.updateOngoingBalance = functions.database.ref('accounts/{accountId}/flows/{flowId}').onWrite(event => {
	const accountId = event.params.accountId;
	const flowId = event.params.flowId;
	const flow = event.data.val();
	let speed = 0;
	if(flow) {
		speed += flow.amount;
	} else {
		flow = event.data.previous.val();
	}
	if (event.data.previous.exists()) { // Update
		const old = event.data.previous.val();
		speed -= old.amount;
	}
		
	if(speed != 0) {
		return db.ref("accounts/"+accountId+"/state").transaction(function (account) {
			if(account == null)
					return null;
		
			const now = moment.utc();
			const start = moment.utc(flow.start);
			const end = flow.end != null ? moment.utc(flow.end) : now;
	
			/* Update account */
			let amount = now.diff(account.current.updated) * account.ongoing.balance;
		
			if(start.isSameOrBefore(now) && end.isBefore(now)) { // Past flow
				amount += end.diff(start) * speed;
			} else if(start.isSameOrBefore(now) && end.isSameOrAfter(now)) { // Ongoing flow
				amount += now.diff(start) * speed;
		
				if(speed > 0) {
					account.ongoing.income += speed;
				} else {
					account.ongoing.expense += speed;
				}
				account.ongoing.balance += speed;
				if(now.isSameOrAfter(account.ongoing.nextUpdate))
					account.ongoing.nextUpdate = end.valueOf();
				else
					account.ongoing.nextUpdate = Math.min(account.ongoing.nextUpdate, end.valueOf());
				account.ongoing.updated = now.valueOf();
			} else if(start.isAfter(now)) { // Future flow
				if(now.isSameOrAfter(account.ongoing.nextUpdate))
					account.ongoing.nextUpdate = start.valueOf();
				else
					account.ongoing.nextUpdate = Math.min(account.ongoing.nextUpdate, start.valueOf());
			}
			console.log("COMPUTE FLOW - %s to %s : %d", start.format("YYYY-MM-DD HH:mm:ss"), end.format("YYYY-MM-DD HH:mm:ss"), amount);

			if(amount != 0) {
				if(amount > 0) {
					account.current.income += amount;
				} else {
					account.current.expense += amount;
				}
				account.current.balance += amount;
			}
			account.current.updated = now.valueOf();
		
			return account;
		
		}, function(error, committed, snapshot) {
			if (error) {
				console.error(error);
			} else if (!committed) {
				console.error('Bad account '+accountId);
			} else {
				console.log('Ongoing updated for '+accountId);
			}
		});
	} else {
		return null;
	}
});


/**
*	Process a member change
*/
exports.processMembers = functions.database.ref('accounts/{accountId}/members/{memberId}').onWrite(event => {
	const accountId = event.params.accountId;
	const memberId = event.params.memberId;
	const member = event.data.exists();
	var updates = {};
	
	if(member && event.data.previous.exists()) { // No existence changes
		return null;
	}
				
	return db.ref('flows').orderByChild("to/id").equalTo(accountId).once("value", function(snap) {
		snap.forEach(function(data) {
			let flow = data.val();
			if(!flow.from.id) {
				if(member) {
					updates['accounts/'+memberId+'/flows/'+data.key] = flow.from.id ? flowTo(flow, null) : flowFrom(flow, null);
				} else {
					updates['accounts/'+memberId+'/flows/'+data.key] = {};
				}
				db.ref('accounts/'+accountId+'/flows/'+data.key).transaction(function (fl) {
					if(fl == null)
							return null;
					if(member) {
						fl.amount += flow.amount;
						fl.nbAccount++;
					} else {
						fl.amount -= flow.amount;
						fl.nbAccount--;
					}
					return fl;
				});
			}
		});
		return db.ref().update(updates, function(error) {
			if (error) {
				console.log("Fail to store flow ", error);
			}
		});
	});
});
				
/**
*	Process universal updates
*/
exports.processUniversal = functions.database.ref('universal/{date}/flows/{accountId}').onWrite(event => {
	const flow = event.data.val();
	const start = moment(event.params.date);
	const accountId = event.params.accountId;
	
	return db.ref("universal/"+event.params.date+"/members").once("value", function(snap) {
		var members = snap.val();
		if(members == null) {
			console.error("Invalid members " + members);
		} else {
			let updates = {};
			if(accountId.startsWith('GIG')) {
				let amount = -flow.amount * members;
		
				var toRef = db.ref("accounts/"+accountId+"/state");
				toRef.transaction(function (account) {
					if(account == null)
							return null;
					return computeFlow(account, start, flow.end, amount);
				});
				let to = {
					amount: amount,
					account: "KOMPANIO-NETWORK",
					by: "KOMPANIO-NETWORK",
					name: "Kompanio Network",
					label: flow.label
				};
				updates['accounts/'+accountId+'/flows/universal'] = to;
				//updates['accounts/'+accountId+'/state/ongoing/balance'] = amount;
				//updates['accounts/'+accountId+'/state/ongoing/income'] = amount;
				//console.log('New amount for ' + accountId + ' : ' + amount);
			} else {
				/**
				 * We update account ongoing balance instead of alter with transaction
				 * as GIG accounts normally receive money only from universals.
				 * TODO: Replace by transaction if GIG policy update
				**/
				console.error('Universal budget contains non GIG account, ignore it');
			}
			return db.ref().update(updates, function(error) {
				if (error) {
					console.log("Fail to store universals ", error);
				}
			});
		}
	});
});

/**
*	Refresh an account balance
*/
exports.refreshBalance = functions.https.onRequest((request, response) => {
  // Retrieve payment card
  var accountId = request.query.accountId;
  if(accountId == null) {
        response.status(404).send("Bad account id");
  } else {
  	var accountRef = db.ref("accounts/"+accountId+"/state");
  	accountRef.once("value", function(snap) {
			var ac = snap.val();
			if(ac == null) {
				response.status(404).send("Unknown account " + accountId);
				return null;
			} else {
				response.status(200).send("In progress");
				const now = moment.utc();
				db.ref('/payments').once("value", function(snapPayments) {
					var payments = snapPayments.val();
					db.ref('/universal').once("value", function(snapUniversal) {
						var universals = snapUniversal.val();
						let paymentsArray = [];
						for(date in universals) {
							let universal = universals[date];
							let payment = { start: date, end: universal.end, speed: universal.revenue };
							if(payment.end == null || moment(payment.end).isAfter(moment(ac.ongoing.updated)))
								paymentsArray.push(payment);
						}
			
						for(paymentId in payments) {
							let payment = payments[paymentId];
							if(payment.speed != null && (payment.end == null || moment(payment.end).isAfter(moment(ac.ongoing.updated)))) // Continuous payment
								paymentsArray.push(payments);
						}
						return accountRef.transaction(function (account) {
							if(account == null) {
								return null;
							}
							compute(now, account, paymentsArray);
							console.log("Account updated ", account);
							return account;
						});
					});
				});
			}
		});
  }
});

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 */
exports.generateThumbnail = functions.storage.object().onChange(event => {
	const filePath = event.data.name;
  const filePathSplit = filePath.split('/');
  const fileName = filePathSplit.pop();
  const fileDir = filePathSplit.join('/') + (filePathSplit.length > 0 ? '/' : '');
  const tempLocalDir = `${LOCAL_TMP_FOLDER}${fileDir}`;
  const tempLocalFile = `${tempLocalDir}${fileName}`;
  const fileNameSplit = fileName.split('.');
  const fileExtension = fileNameSplit.pop();
  const baseFileName = fileNameSplit.join('.');
  const JPEGFilePath = `${fileDir}${baseFileName}.${JPEG_EXTENSION}`;//
  const thumbFilePath = `${fileDir}${THUMB_PREFIX}${baseFileName}.${JPEG_EXTENSION}`;//
  const tempLocalJPEGFile = `${LOCAL_TMP_FOLDER}${JPEGFilePath}`;//
  const tempLocalThumbFile = `${LOCAL_TMP_FOLDER}${thumbFilePath}`;

	// Exit if the file is not an photo file.
  if (!filePath.startsWith(PHOTOS_DIR)) {
    console.log('Not an photo file.');
    return;
  }
  
	// Exit if this is triggered on a file that is not an image.
  if (!event.data.contentType.startsWith('image/')) {
    console.log('This is not an image.');
    return;
  }

  // Exit if the image is already a thumbnail.
  if (fileName.startsWith(THUMB_PREFIX)) {
    console.log('Already a Thumbnail.');
    return;
  }

  // Exit if this is a move or deletion event.
  if (event.data.resourceState === 'not_exists') {
    console.log('This is a deletion event.');
    return;
  }
  
  // Create the temp directory where the storage file will be downloaded.
  return mkdirp(tempLocalDir).then(() => {
    // Download file from bucket.
    const bucket = gcs.bucket(BUCKET_NAME);
    return bucket.file(filePath).download({
      destination: tempLocalFile
    }).then(() => {
      console.log('The file has been downloaded to', tempLocalFile);
      // Generate a thumbnail using ImageMagick.
      return exec(`convert "${tempLocalFile}" "${tempLocalJPEGFile}"`).then(() => {
      	console.log('JPEG image created at', tempLocalJPEGFile);
				return spawn('convert', [tempLocalJPEGFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}^`, '-gravity', 'center', '-extent', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}`, tempLocalThumbFile]).then(() => {
					console.log('Thumbnail created at', tempLocalThumbFile);
					// Uploading the Thumbnail.
					return bucket.upload(tempLocalThumbFile, {
						destination: thumbFilePath
					}).then(() => {
						console.log('Thumbnail uploaded to Storage at', thumbFilePath);
					});
				});
			});
    });
  });
});

router.use(cors);
router.use(validateFirebaseIdToken);
router.get('*', (request, response) => {
	console.log("Authorize ", request.body);
  // Retrieve payment card
  authorizePayment(request.body).then(function(result) {
  	response.status(200).send({result:result});
  }).catch(function(error) {
  	console.error('Authorization failed :', error);
  	response.status(300).send({ error:error });
  });
});

// This HTTPS endpoint can only be accessed by your Firebase Users.
// Requests need to be authorized by providing an `Authorization` HTTP header
// with value `Bearer <Firebase ID Token>`.
// NOTE: You need to add a trailing slash to the Function's URL becasue of this issue: https://github.com/firebase/firebase-functions/issues/27
/**
*	Authorize a payment
*/
exports.authorize = functions.https.onRequest((request, response) => {
	console.log("Authorize ", request.body);
  // Retrieve payment card
  authorizePayment(request.body).then(function(card) {
  	response.status(200).send({ account: card.account, older: card.older });
  }).catch(function(error) {
  	console.error('Authorization failed :', error);
  	response.status(300).send({ message:error });
  });
});

/**
*	Search for identities
*/
exports.identities = functions.https.onRequest((request, response) => {
	cors(request, response, () => {
		let parts = request.query.q.toLowerCase().split(" ");
		let matchIdentities = [];
		db.ref("users/").once("value", function(snap) {
			const users = snap.val();
			for(i in users) {
				let identity = { $key: i, name: users[i].identity.firstName + ' ' + users[i].identity.lastName };
				let names = identity.name.toLowerCase().split(" ");
				let match = false;
				for(p of parts) {
					for(n of names) {
						if(n.startsWith(p))
							match = true;
					}
				}
				if(match) {
					matchIdentities.push(identity);
				}
			}
			if(request.query.groups) {
				db.ref("groups/").once("value", function(snap) {
					const groups = snap.val();
				
					for(i in groups) {
						let identity = { $key: i, name: groups[i].name };
						let names = identity.name.toLowerCase().split(" ");
						let match = false;
						for(p of parts) {
							for(n of names) {
								if(n.startsWith(p))
									match = true;
							}
						}
						if(match) {
							matchIdentities.push(identity);
						}
					}
					response.status(200).send(matchIdentities);
				});
			} else {
				response.status(200).send(matchIdentities);
			}
		});
	});
});