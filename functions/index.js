var functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

var db = admin.database();

// Start writing Firebase Functions
// https://firebase.google.com/preview/functions/write-firebase-functions

exports.helloWorld = functions.https.onRequest((request, response) => {
 response.send("Hello from Firebase!");
})

exports.authorize = functions.https.onRequest((request, response) => {
  // Retrieve payment card
  if(request.body.amount <= 0) {
        response.status(404).send("Bad amount");
  } else {
	  db.ref("cards/"+request.body.cardId).once("value", function(snapCard) {
		const card = snapCard.val();
		/* Check token */
		if(card == null) {
			response.status(404).send("Unknown card");
		} else if(request.body.token !== card.token) {
			response.status(300).send("Bad card token");
		} else if(!card.isValid) {
			response.status(300).send("Card not valid");
		} else {
			db.ref("accounts/"+request.body.to).once("value", function(snapTo) {
				const toAccount = snapTo.val();
				if(toAccount == null) {
					response.status(404).send("Recipient account not found");
				} else if(toAccount.maxBalance != null && (toAccount.balance + request.body.amount) > toAccount.maxBalance) {
					response.status(300).send("Recipient balance over quota");
				} else {
					db.ref("accounts/"+card.accountId).once("value", function(snapFrom) {
						const fromAccount = snapFrom.val();
						if(fromAccount == null) {
							response.status(404).send("Card account not found");
						} else if((fromAccount.balance - request.body.amount) < 0) {
							response.status(300).send("Insufficient funds");
						} else {
							response.status(200).send("Auth OK");
						}
					});
				}
			});
		}
	  });
  }
})

exports.createAccount = functions.database.ref('users/{pushId}')
    .onWrite(event => {
      // Grab the current value of what was written to the Realtime Database.
      const user = event.data.val();
      if(user.accountId != null) // Account already exists
          return null;
      
      console.log("Create user account ", user);

        let account = {
          type: "personal",
          balance: 0,
          balanceUpdated: new Date().getTime(),
          speed: 0,
          upcoming: 0,
          name: user.identity.firstName + ' ' + user.identity.lastName.toUpperCase(),
          imageUrl: user.identity.imageUrl,
        };
        let accountRef = db.ref("accounts").push();
        db.ref('users/'+event.params.pushId+'/accountId').set(accountRef.key);
        return accountRef.set(account);
    });


exports.processPayment = functions.database.ref('payments/{paymentId}')
    .onWrite(event => {
      // Grab the current value of what was written to the Realtime Database.
      const payment = event.data.val();
      if(payment.executed != null)
          return null;
    
      console.log("Process new payment ", payment);
    
      const updated = new Date().getTime();
      var fromRef = db.ref("accounts/"+payment.from);
      var toRef = db.ref("accounts/"+payment.to);
        fromRef.transaction(function (account) {
          if(account == null)
              return null;
          account.balance -= payment.amount;
          account.balanceUpdated = updated;
          return account;
        });
        toRef.transaction(function (account) {
          if(account == null)
              return null;
          account.balance += payment.amount;
          account.balanceUpdated = updated;
          return account;
        });
        return db.ref("payments/"+event.params.paymentId+"/executed").set(updated);
    });

exports.processAuthorization = functions.database.ref('authorizations/{authId}')
    .onWrite(event => {
      // Grab the current value of what was written to the Realtime Database.
      const authorization = event.data.val();
      if(authorization.status != null)
          return null;
    
      console.log("Process new payment authorization ", authorization);
      const authRef = db.ref("authorizations/"+event.params.authId+"/status");
      const dateTime = new Date().getTime();
      db.ref("cards/"+authorization.cardId).once("value", function(snapshot) {
          const card = snapshot.val();
          console.log("Card used ", card);
          
          /* Compute card token validity */
          if(authorization.token !== card.token) {
              console.error("Payment authorization rejected ", authorization);
              return authRef.set({code: "reject", message: "Bad token"});
          }
          
          /* Store transaction */
          let payment = {
              created: dateTime,
              authorizationId: event.params.authId,
              amount: authorization.amount,
              from: card.accountId,
              to: authorization.to
            };
            const paymentRef = db.ref("payments").push();
            return paymentRef.set(payment, function(error) {
              if (error) {
                console.error("Data could not be saved " + error);
              } else {
                console.log("Payment auth executed");
                authRef.set({code: "executed", message: "Payment " + paymentRef.key, executed: dateTime});
              }
            });
      });
    });