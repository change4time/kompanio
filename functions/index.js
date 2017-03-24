var functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

var db = admin.database();

// Start writing Firebase Functions
// https://firebase.google.com/preview/functions/write-firebase-functions

exports.helloWorld = functions.https.onRequest((request, response) => {
 response.send("Hello from Firebase!");
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
          name: user.firstName + ' ' + user.lastName.toUpperCase(),
          imgUrl: user.image,
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

exports.processPaymentAuth = functions.database.ref('paymentAuths/{paymentAuthId}')
    .onWrite(event => {
      // Grab the current value of what was written to the Realtime Database.
      const paymentAuth = event.data.val();
      if(paymentAuth.executed != null)
          return null;
    
      console.log("Process new payment authorization ", paymentAuth);
      const paymentAuthRef = db.ref("paymentAuths/"+event.params.paymentAuthId+"/status");
      const created = new Date().getTime();
      db.ref("cards/"+paymentAuth.cardId).then(card => {
          /* Compute card token validity */
          if(paymentAuth.token == card.token) {
              cosole.error("Payment authorization rejected ", paymentAuth);
              return paymentAuthRef.update({code: "reject", message: "Bad token"});
          }
          
          /* Store transaction */
          let transaction = {
              created: created,
              paymentAuthId: event.params.paymentAuthId,
              amount: paymentAuth.amount,
              from: card.accountId,
              to: paymentAuth.to
            };
            db.ref("transactions").push().set(transaction).then(o => {
                return db.ref("paymentAuths/"+event.params.paymentAuthId+"/executed").set(created);
            });
      });
    });