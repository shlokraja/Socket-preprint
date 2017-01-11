/*global console require module*/
'use strict';

var express = require('express');
var router = express.Router();
var pg = require('pg');
var request = require('request');
var debug = require('debug')('Foodbox-HQ:server');
var format = require('string-format');
var nodemailer = require('nodemailer');
var _ = require('underscore');
var async = require('async');
var Firebase = require('firebase');
var Queue = require('firebase-queue');
var redis = require('redis');
format.extend(String.prototype);
var config = require('../models/config');
var dbUtils = require('../models/dbUtils');
var conString = config.dbConn;
var general = require('../api/general');
var moment = require('moment');
//var billProcess = require('../utils/BillProcess');

// create reusable transporter object using SMTP transport
var transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: 'no-reply@atchayam.in',
        pass: 'Atchayam123'
    }
});

var redisClient = redis.createClient({ connect_timeout: 2000, retry_max_delay: 5000 });
redisClient.on('error', function (msg) {
    console.error(msg);
});


redisClient.select(1, function (err) {
    if (err) {
        console.error("Selecting Db Failed" + err)
    }
});

// Handlers for outlet related code

// Listing all the outlets
router.get('/', function (req, res, next) {

    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('SELECT * from outlet', function (query_err, result) {
            if (query_err) {
                handleError(client, done, res, 'Listing Outlets :: error running query' + query_err);
                return;
            }

            // releasing the connection
            done();
            var context = { title: 'Foodbox', outlets: result.rows };
            if (req.query.create) {
                context.outlet_created = true;
            }
            if (req.query.update) {
                context.outlet_updated = true;
            }

            res.render('list_outlets', context);
        });

    });

});


router.post('/DirectBill', function (req, res, next) {
    console.log("DirectBill: " + JSON.stringify(req.body));
    console.log("DirectBill: " + req.body.bill_no);
    var queueItem = req.body;
    console.log("Got order details from queue :" + queueItem.bill_no + "Outlet Id : " + queueItem.outlet_id);
    if (queueItem.name == "ORDER_DETAILS") {
        // process the order details
        console.log("ORDER_DETAILS")
        var order_details = queueItem.order_details;
        var sides = queueItem.sides;
        var counter_code = queueItem.counter_code;
        var payment_method = queueItem.payment_mode;
        var outlet_id = queueItem.outlet_id;
        var unique_random_id = queueItem.unique_Random_Id;
        var order_barcodes = queueItem.order_barcodes;
        //var order_barcodes = ["CH018KUM04V7211220161443"];
        if (order_barcodes == undefined) {
            order_barcodes = [];
        }
        var mobile_num = queueItem.mobile_num;
        var credit_card_no = queueItem.credit_card_no;
        var cardholder_name = queueItem.cardholder_name;
        var bill_no = queueItem.bill_no;
        var food_details = queueItem.food_details;
        var is_mobile_order = queueItem.is_mobile_order;
        var total_quantity = 0;
        var barcode_dict = {};
        var total_price = 0;

        for (var i = 0; i < order_barcodes.length; i++) {
            if (order_barcodes[i] in barcode_dict) {
                barcode_dict[order_barcodes[i]]++;
            } else {
                barcode_dict[order_barcodes[i]] = 1;
            }
        }

        for (var item_id in order_details) {
            total_quantity += order_details[item_id].count;
            if (!isNaN(order_details[item_id].price)) {

                total_price += order_details[item_id].price;
            }
        }

        for (var item_id in sides) {
            if (!isNaN(sides[item_id].price)) {

                total_price += sides[item_id].price;
            }
        }
        config.query('INSERT INTO sales_order (outlet_id, time, counter_code, method, mobile_num, cardholder_name, card_no,unique_random_key,is_mobile_order)\
      VALUES($1, now(), $2, $3, $4, $5, $6,$7,$8) \
      RETURNING id',
            [outlet_id, counter_code, payment_method, mobile_num, cardholder_name, credit_card_no, unique_random_id, is_mobile_order],
            function (query_err, result) {
                if (query_err) {
                    console.error(query_err);
                    debug("Sales Order Error :" + query_err);
                    //req.body.status="error";
                    res.status(500).send(req.body);
                }

                console.log("Sales Order **** : " + JSON.stringify(result));
                if (result != null && result.rows != null && result.rows.length > 0) {
                    var sales_order_id = result.rows[0].id;
                    debug("Created sales order id- ", sales_order_id);
                    async.map(_.keys(food_details),
                        function (item_id, map_callback) {
                            config.query('INSERT INTO bill_items \
              VALUES ($1, $2, $3, $4, get_dispense_status($3)::dispense_status,$5,$6)', [sales_order_id,
                                    bill_no, item_id, food_details[item_id], mobile_num, is_mobile_order], map_callback);
                        },
                        function (map_err, map_results) {
                            if (map_err) {
                                console.error(map_err);
                                debug("Bill Items Error :" + map_err);
                                //reject();
                                //req.body.status="error";
                                res.status(500).send(req.body);
                            }
                            //resolve();
                        });


                    for (var barcode in barcode_dict) {
                        var item_id = getItemId(barcode);
                        console.log("sales_order_items  Order **** values : " + sales_order_id + " -" + item_id + "- " + barcode_dict + "- " + barcode);
                        config.query('INSERT INTO sales_order_items \
            VALUES ($1, $2, $3, $4)',
                            [sales_order_id, item_id, barcode_dict[barcode], barcode],
                            function (items_err, items_result) {
                                if (items_err) {
                                    console.error(items_err);
                                    debug("Sales Order Items Error :" + items_err);
                                    //req.body.status="error";
                                    res.status(500).send(req.body);
                                }
                            });
                    }

                    config.query('INSERT INTO sales_order_payments \
          VALUES ($1, $2, $2, $3, $4)',
                        [sales_order_id, total_price, 'sold', 'original'],
                        function (payment_error, payment_result) {
                            if (payment_error) {
                                console.error(payment_error);
                                debug("Sales Order Payment Error :" + payment_error);
                                //req.body.status="error";
                                res.status(500).send(req.body);
                            }
                            else {
                                //req.body.status="success";
                                res.status(200).send(req.body);
                            }
                        });
                }
            });
        //res.send('success');
    }
})


router.post('/Check_Missing_Bills', function (req, res, next) {

    if (req.body.bills != undefined) {
        //var bills = JSON.parse(req.body.bills);
        if (req.body.bills.length > 0) {
            console.log("outlet.js :: Check_Missing_Bills: Reached = " + req.body.bills.length);
            var out = req.body.bills[0];
            console.log(out.outlet_id);
            redisClient.del(out.outlet_id);
            for (var i = 0; i < req.body.bills.length; i++) {
                var obj = req.body.bills[i];
                redisClient.lpush(obj.outlet_id, JSON.stringify(req.body.bills[i]));
                console.log(req.body.bills[i].bill_no);
            }
            console.log("Success");
            res.status(200).send("success");
        }
        else {
            res.status(200).send("No Bills to Process");
        }
    }
    else {
        console.log("Check_Missing_Bills :Bill Undefined")
        res.status(500).send("Error");
    }
});



// Creating a outlet
router.get('/create', function (req, res, next) {
    res.render('create_outlet', { title: 'Foodbox' });
});


router.post('/create', function (req, res, next) {

    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        // This is the no. of initial params upon which more are dynamically added
        var num_params = 13;
        var params = [req.body.name,
        req.body.short_name,
        req.body.address,
        req.body.start_of_day,
        req.body.end_of_day,
        sanitizeInteger(req.body.num_ordering_screens),
        sanitizeInteger(req.body.num_live_ordering_screens),
        req.body.cash_at_start,
        req.body.active,
        req.body.force_print_bill,
        req.body.is24hr,
        req.body.city_code];
        // Adding the payment methods to the param array. Otherwise node-postgres
        // wouldn't take the param for the array data type.
        params = params.concat((req.body.payment_methods).split(','));

        // Doing this to dynamically construct the query string depending on no. of
        // payment methods
        var arr = [];
        for (var i = 0; i < req.body.payment_methods.split(',').length; i++) {
            arr.push('$' + (i + num_params));
        }

        client.query('INSERT into outlet \
    (name, short_name, address, start_of_day, end_of_day, num_ordering_screens, \
      num_live_ordering_screens, cash_at_start, active, force_print_bill, is24hr, city, payment_methods) \
  values ($1, $2, $3, $4, $5, $6, $7, \
    $8, $9, $10, $11, $12, ARRAY[' + arr.join(',') + ']::payment_method[])', params,
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'Create :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();

                res.redirect('/outlet?create=true');
            });

    });

});

// Updating a outlet
router.get('/update/:id', function (req, res, next) {
    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        var outlet_id = req.params.id;

        client.query('SELECT * FROM outlet \
      WHERE id=$1', [outlet_id], function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'Update outlet :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();

                res.render('update_outlet', { title: 'Foodbox', outlet: result.rows[0] });
            });

    });
});

router.post('/update/:id', function (req, res, next) {

    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        var outlet_id = req.params.id;
        // This is the no. of initial params upon which more are dynamically added
        var num_params = 13;
        var params = [req.body.name,
        req.body.short_name,
        req.body.address,
        req.body.start_of_day,
        req.body.end_of_day,
        sanitizeInteger(req.body.num_ordering_screens),
        sanitizeInteger(req.body.num_live_ordering_screens),
        req.body.cash_at_start,
        req.body.active,
        req.body.force_print_bill,
        req.body.is24hr,
        req.body.city_code];
        // Adding the payment methods to the param array. Otherwise node-postgres
        // wouldn't take the param for the array data type.
        params = params.concat((req.body.payment_methods).split(','));
        // Adding the outlet_id
        params.push(outlet_id);

        // Doing this to dynamically construct the query string depending on no. of
        // payment methods
        var arr = [];
        for (var i = 0; i < req.body.payment_methods.split(',').length; i++) {
            arr.push('$' + (i + num_params));
        }
        client.query('UPDATE outlet \
    SET name=$1, short_name=$2, address=$3, start_of_day=$4, end_of_day=$5, \
    num_ordering_screens=$6, num_live_ordering_screens=$7, cash_at_start=$8, active=$9, \
    force_print_bill=$10, is24hr=$11, city=$12, payment_methods=ARRAY[' + arr.join(',') + ']::payment_method[] \
    WHERE id=$' + (i + num_params), params,
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/update/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();

                res.redirect('/outlet?update=true');
            });

    });

});

// This returns the no. of monitors for an outlet
router.get('/num_monitors/:id', function (req, res, next) {
    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        var outlet_id = req.params.id;

        client.query('SELECT num_ordering_screens, num_live_ordering_screens FROM outlet \
      WHERE id=$1', [outlet_id], function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/num_monitors/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();

                res.send(result.rows[0]);
            });

    });
});

// Getting an outlet
router.get('/get/:id', function (req, res, next) {

    pg.connect(conString, function (err, client, done) {

        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        var outlet_id = req.params.id;

        client.query('SELECT * FROM outlet \
      WHERE id=$1', [outlet_id], function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/get/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();

                res.render('get_outlet', { title: 'Foodbox', outlet: result.rows[0] });
            });

    });
});

router.get('/special_timings_page/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    res.render('special_timings', { title: 'Foodbox', outlet_id: outlet_id });
});

router.post('/special_timings_page/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var data = req.body.data;
    debug(data);
    // extracting the items
    var items = data.split(';');
    debug(items);
    var query_string = '';
    for (var i = 0; i < items.length; i++) {
        var data_per_item = items[i].split(',');
        var start_time = data_per_item[0];
        var end_time = data_per_item[1];
        var slot_name = data_per_item[2];
        // not making a prepared statement because there are multiple commands
        // might need to revisit when the actual frontend gets built
        query_string += 'INSERT INTO special_timings \
    VALUES (\'{}\', \'{}\', {}, \'{}\');'.format(start_time, end_time, outlet_id, slot_name);
    }

    // inserting in the DB
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query(query_string, function (query_err, result) {
            if (query_err) {
                handleError(client, done, res, 'special_timings_page :: error running query' + query_err);
                return;
            }

            // releasing the connection
            done();

            res.redirect('/');
        });

    });

});

// Getting the page for setting special timing images
router.get('/special_timings/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var date_obj = new Date();
    var current_time = date_obj.toLocaleTimeString();

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT slot_name FROM special_timings \
      WHERE outlet_id=$1 and start_time<$2 and end_time>$3',
            [outlet_id, current_time, current_time],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/special_timings/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                if (result.rows.length === 0) {
                    res.send('none');
                } else {
                    res.send(result.rows[0].slot_name);
                }
            });

    });
});

// Returning the plc config settings
router.get('/plc_config/:id', function (req, res, next) {
    var outlet_id = req.params.id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT * FROM outlet_plc_config \
      WHERE outlet_id=$1',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/plc_config/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result.rows[0]);
            });

    });
});

router.get('/supply_list/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT id, name, image_url FROM food_item f, supplies_master_list s\
      WHERE f.id=s.food_item_id AND s.outlet_id=$1 and s.restaurant_id is null',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/supply_list/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result.rows);
            });
    });
});

// Returning the outlet config settings
router.get('/outlet_config/:id', function (req, res, next) {
    var outlet_id = req.params.id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT * FROM outlet \
      WHERE id=$1',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/outlet_config/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result.rows[0]);
            });

    });
});

router.post('/DirectBill', function (req, res, next) {
    console.log("DirectBill: " + req.body.bill_no);
    var queueItem = req.body;
    debug("Got order details from queue :" + queueItem.bill_no + "Outlet Id : " + queueItem.outlet_id);
    //if (queueItem.name == "ORDER_DETAILS") {
    // process the order details
    debug("ORDER_DETAILS")
    var order_details = queueItem.order_details;
    var sides = queueItem.sides;
    var counter_code = queueItem.counter_code;
    var payment_method = queueItem.payment_mode;
    var outlet_id = queueItem.outlet_id;
    var unique_random_id = queueItem.unique_Random_Id;
    var order_barcodes = queueItem.order_barcodes;
    if (order_barcodes == undefined) {
        order_barcodes = [];
    }
    var mobile_num = queueItem.mobile_num;
    var credit_card_no = queueItem.credit_card_no;
    var cardholder_name = queueItem.cardholder_name;
    var bill_no = queueItem.bill_no;
    var food_details = queueItem.food_details;
    var is_mobile_order = queueItem.is_mobile_order;
    var total_quantity = 0;
    var barcode_dict = {};
    var total_price = 0;

    for (var i = 0; i < order_barcodes.length; i++) {
        if (order_barcodes[i] in barcode_dict) {
            barcode_dict[order_barcodes[i]]++;
        } else {
            barcode_dict[order_barcodes[i]] = 1;
        }
    }

    for (var item_id in order_details) {
        total_quantity += order_details[item_id].count;
        if (!isNaN(order_details[item_id].price)) {

            total_price += order_details[item_id].price;
        }
    }

    for (var item_id in sides) {
        if (!isNaN(sides[item_id].price)) {

            total_price += sides[item_id].price;
        }
    }

    config.query('INSERT INTO sales_order (outlet_id, time, counter_code, method, mobile_num, cardholder_name, card_no,unique_random_key,is_mobile_order)\
      VALUES($1, now(), $2, $3, $4, $5, $6,$7,$8) \
      RETURNING id',
        [outlet_id, counter_code, payment_method, mobile_num, cardholder_name, credit_card_no, unique_random_id, is_mobile_order],
        function (query_err, result) {
            if (query_err) {
                console.error(query_err);
                debug("Sales Order Error :" + query_err);
                res.send('error');
            }


            if (result != null && result.rows != null && result.rows.length > 0) {
                var sales_order_id = result.rows[0].id;
                debug("Created sales order id- ", sales_order_id);
                async.map(_.keys(food_details),
                    function (item_id, map_callback) {
                        config.query('INSERT INTO bill_items \
              VALUES ($1, $2, $3, $4, get_dispense_status($3)::dispense_status,$5,$6)', [sales_order_id,
                                bill_no, item_id, food_details[item_id], mobile_num, is_mobile_order], map_callback);
                    },
                    function (map_err, map_results) {
                        if (map_err) {
                            console.error(map_err);
                            debug("Bill Items Error :" + map_err);
                            //reject();
                            res.send('error');
                        }
                        //resolve();
                    });


                for (var barcode in barcode_dict) {
                    var item_id = getItemId(barcode);
                    config.query('INSERT INTO sales_order_items \
            VALUES ($1, $2, $3, $4)',
                        [sales_order_id, item_id, barcode_dict[barcode], barcode],
                        function (items_err, items_result) {
                            if (items_err) {
                                console.error(items_err);
                                debug("Sales Order Items Error :" + items_err);
                                res.send('error');
                            }
                        });
                }

                config.query('INSERT INTO sales_order_payments \
          VALUES ($1, $2, $2, $3, $4)',
                    [sales_order_id, total_price, 'sold', 'original'],
                    function (payment_error, payment_result) {
                        if (payment_error) {
                            console.error(payment_error);
                            debug("Sales Order Payment Error :" + payment_error);
                            res.send('error');
                        }
                        else {
                            res.send('success');
                        }
                    });
            }
        });
    //res.send('success');
    //}
})


// This serves as the order processing queue
// and also for dispense status update
var queueRef = new Firebase(process.env.FIREBASE_QUEUE);

console.log("Firebase Queue: " + queueRef);
var queue = new Queue(queueRef, function (data, progress, resolve, reject) {
    var queueItem = data;
    debug("Got order details from queue :" + queueItem.bill_no + "Outlet Id : " + queueItem.outlet_id);
    if (queueItem.name == "ORDER_DETAILS") {
        // process the order details
        debug("ORDER_DETAILS")
        var order_details = queueItem.order_details;
        var sides = queueItem.sides;
        var counter_code = queueItem.counter_code;
        var payment_method = queueItem.payment_mode;
        var outlet_id = queueItem.outlet_id;
        var unique_random_id = queueItem.unique_Random_Id;
        var order_barcodes = queueItem.order_barcodes;
        if (order_barcodes == undefined) {
            order_barcodes = [];
        }
        var mobile_num = queueItem.mobile_num;
        var credit_card_no = queueItem.credit_card_no;
        var cardholder_name = queueItem.cardholder_name;
        var bill_no = queueItem.bill_no;
        var food_details = queueItem.food_details;
        var is_mobile_order = queueItem.is_mobile_order;
        var total_quantity = 0;
        var barcode_dict = {};
        var total_price = 0;

        for (var i = 0; i < order_barcodes.length; i++) {
            if (order_barcodes[i] in barcode_dict) {
                barcode_dict[order_barcodes[i]]++;
            } else {
                barcode_dict[order_barcodes[i]] = 1;
            }
        }

        for (var item_id in order_details) {
            total_quantity += order_details[item_id].count;
            if (!isNaN(order_details[item_id].price)) {

                total_price += order_details[item_id].price;
            }
        }

        for (var item_id in sides) {
            if (!isNaN(sides[item_id].price)) {

                total_price += sides[item_id].price;
            }
        }

        config.query('INSERT INTO sales_order (outlet_id, time, counter_code, method, mobile_num, cardholder_name, card_no,unique_random_key,is_mobile_order)\
      VALUES($1, now(), $2, $3, $4, $5, $6,$7,$8) \
      RETURNING id',
            [outlet_id, counter_code, payment_method, mobile_num, cardholder_name, credit_card_no, unique_random_id, is_mobile_order],
            function (query_err, result) {
                if (query_err) {
                    console.error(query_err);
                    debug("Sales Order Error :" + query_err);
                    return;
                }


                if (result != null && result.rows != null && result.rows.length > 0) {
                    var sales_order_id = result.rows[0].id;
                    debug("Created sales order id- ", sales_order_id);
                    async.map(_.keys(food_details),
                        function (item_id, map_callback) {
                            config.query('INSERT INTO bill_items \
              VALUES ($1, $2, $3, $4, get_dispense_status($3)::dispense_status,$5,$6)', [sales_order_id,
                                    bill_no, item_id, food_details[item_id], mobile_num, is_mobile_order], map_callback);
                        },
                        function (map_err, map_results) {
                            if (map_err) {
                                console.error(map_err);
                                debug("Bill Items Error :" + map_err);
                                reject();
                                return;
                            }
                            resolve();
                        });


                    for (var barcode in barcode_dict) {
                        var item_id = getItemId(barcode);
                        config.query('INSERT INTO sales_order_items \
            VALUES ($1, $2, $3, $4)',
                            [sales_order_id, item_id, barcode_dict[barcode], barcode],
                            function (items_err, items_result) {
                                if (items_err) {
                                    console.error(items_err);
                                    debug("Sales Order Items Error :" + items_err);
                                    return;
                                }
                            });
                    }

                    config.query('INSERT INTO sales_order_payments \
          VALUES ($1, $2, $2, $3, $4)',
                        [sales_order_id, total_price, 'sold', 'original'],
                        function (payment_error, payment_result) {
                            if (payment_error) {
                                console.error(payment_error);
                                debug("Sales Order Payment Error :" + payment_error);
                                return;
                            }
                        });

                    if (is_mobile_order) {
                        var orderno = general.leftPad(outlet_id, 3) + general.leftPad(bill_no, 6);
                        console.log("save_mobile_pending_orders: isMobileOrder: " + is_mobile_order + " MobileNo: " + mobile_num + " OrderNumber: " + orderno + " Quantity: " + total_quantity + " Outlet_Id: " + outlet_id);
                        config.query('INSERT INTO mobile_pending_orders (mobileno,orderno,quantity,outlet_id,order_date)\
              VALUES ($1, $2, $3,$4,current_timestamp)',
                            [mobile_num, orderno, total_quantity, outlet_id],
                            function (query_err, result) {
                                if (query_err) {
                                    console.error(query_err);
                                    console.log("save_mobile_pending_orders: Insert mobile_pending_orders error running query" + query_err);
                                    debug("Mobile Order Error :" + query_err);
                                    return;
                                }
                            });
                    }

                }
            });

    } else if (queueItem.name == "DISPENSE_STATUS_UPDATE") {
        // update the dispense status
        debug("DISPENSE_STATUS_UPDATE")
        var dispense_status_data = queueItem.data;
        var outlet_id = queueItem.outlet_id;
        debug("Received dispense data as- ", JSON.stringify(dispense_status_data));

        async.map(_.keys(dispense_status_data),
            function (bill_no, map_callback) {
                // update bill_items table with the appropriate bill_no and status
                config.query('UPDATE bill_items \
          set dispense_status=$1 \
          where bill_no=$2 \
          and sales_order_id=(select max(id) \
            from sales_order s, bill_items b \
            where s.id=b.sales_order_id \
            and s.outlet_id=$3 \
            and b.bill_no=$2 )',
                    [dispense_status_data[bill_no], bill_no, outlet_id],
                    map_callback);

                var is_mobile_order = false;
                // Update order status in order history (for mobile)
                pg.connect(conString, function (err, client, done) {

                    if (err) {
                        console.log("DISPENSE_STATUS_UPDATE: connectin error " + err);
                        debug("DISPENSE_STATUS_UPDATE:" + err)
                        return;
                    }

                    client.query('select distinct bill_no,mobileno,is_mobile_order,sales_order_id from bill_items \
            where bill_no=$1 and sales_order_id=(select max(id) from sales_order s, bill_items b where s.id=b.sales_order_id and s.outlet_id=$2 and b.bill_no=$1 )',
                        [bill_no, outlet_id], function (query_err, result_bill_details) {
                            if (query_err) {
                                console.log("DISPENSE_STATUS_UPDATE: select bill details " + query_err);
                                debug("DISPENSE_STATUS_UPDATE: select bill details" + query_err)
                                return;
                            }

                            // releasing the connection
                            done();

                            var bill_details = result_bill_details.rows;

                            if (bill_details != undefined && bill_details != null && bill_details.length > 0) {

                                is_mobile_order = bill_details[0].is_mobile_order;
                                if (is_mobile_order) {
                                    console.log("DISPENSE_STATUS_UPDATE:  is_mobile_order: " + is_mobile_order + "Bill_no: " + bill_no + "status: " + dispense_status_data[bill_no]);
                                    // UpdateOrderHistoryStatus(outlet_id, bill_details[0].mobileno, bill_no, dispense_status_data[bill_no]);
                                    debug("DISPENSE_STATUS_UPDATE:  is_mobile_order: " + is_mobile_order + "Bill_no: " + bill_no + "status: " + dispense_status_data[bill_no]);
                                    UpdateOrderHistoryStatus(outlet_id, bill_details[0].mobileno, bill_no, 'delivered');
                                }
                            }
                        });

                });
            },
            function (map_err, map_results) {
                if (map_err) {
                    console.error(map_err);
                    debug("DISPENSE_STATUS_UPDATE Map: " + map_err);
                    reject();
                    return;
                }
                _.each(map_results, function (res) {
                    debug("Updated dispense status for ", res.rows.length, " rows");
                });
                resolve();
            });
    }
    resolve();
});

// This handler stores the order details
router.post('/place_order', function (req, res, next) {
    var order_details = req.body.order_details;
    var sides = req.body.sides;
    var counter_code = req.body.counter_code;
    var payment_method = req.body.payment_mode;
    var outlet_id = req.body.outlet_id;
    var order_barcodes = req.body.order_barcodes;
    var mobile_num = req.body.mobile_num;
    var credit_card_no = req.body.credit_card_no;
    var cardholder_name = req.body.cardholder_name;
    var unique_random_id = req.body.unique_random_id != undefined ? req.body.unique_random_id : '';
    var barcode_dict = {};

    if (order_barcodes != null || order_barcodes != undefined) {
        for (var i = 0; i < order_barcodes.length; i++) {
            if (order_barcodes[i] in barcode_dict) {


                barcode_dict[order_barcodes[i]]++;
            } else {

                barcode_dict[order_barcodes[i]] = 1;
            }
        }
    }

    var total_price = 0;
    for (var item_id in order_details) {

        total_price += order_details[item_id].price;
    }
    for (var item_id in sides) {
        total_price += sides[item_id].price;
    }


    config.query('INSERT INTO sales_order (outlet_id, time, counter_code, method, mobile_num, cardholder_name, card_no,unique_random_key)\
    VALUES($1, now(), $2, $3, $4, $5, $6,$7) \
    RETURNING id',
        [outlet_id, counter_code, payment_method, mobile_num, cardholder_name, credit_card_no, unique_random_id],
        function (query_err, result) {
            if (query_err) {

                console.error(query_err);

                res.status(500).send(query_err);
                return;
            }
            var sales_order_id = result.rows[0].id;

            for (var barcode in barcode_dict) {
                var item_id = getItemId(barcode);
                config.query('INSERT INTO sales_order_items \
          VALUES ($1, $2, $3, $4)',
                    [sales_order_id, item_id, barcode_dict[barcode], barcode],
                    function (items_err, items_result) {
                        if (items_err) {

                            console.error(items_err);
                            return;
                        }
                    });
            }

            config.query('INSERT INTO sales_order_payments \
        VALUES ($1, $2, $2, $3, $4)',
                [sales_order_id, total_price, 'sold', 'original'],
                function (payment_error, payment_result) {
                    if (payment_error) {
                        console.error(payment_error);
                        return;
                    }
                });
            res.send(sales_order_id.toString());
        });
});

// This handler stores the bill details for a single order
router.post('/store_bill', function (req, res, next) {
    var sales_order_id = req.body.sales_order_id;
    var bill_no = req.body.bill_no;
    var food_details = req.body.food_details;

    for (var item_id in food_details) {
        config.query('INSERT INTO bill_items \
      VALUES ($1, $2, $3, $4, get_dispense_status($3)::dispense_status,$5)', [sales_order_id,
                bill_no, item_id, food_details[item_id], null], function (err, result) {
                    if (err) {
                        console.error(err);
                        return res.status(500).send(err);
                    }
                });
    }
    res.send('success');
});

router.post('/wipe_bill_items', function (req, res, next) {
    /* var bill_no = req.body.bill_no;
     var food_item_id = req.body.food_item_id;
     config.query('select wipe_bill($1, $2)',
       [bill_no, food_item_id],
       function(err, result) {
         if(err) {
           console.error(err);
           return res.status(500).send(err);
         }
         res.send('success');
       });*/
    res.send('success');
});

router.get('/mobile_num/:bill_no', function (req, res, next) {
    var bill_no = req.params.bill_no;
    config.query('SELECT mobile_num \
    FROM sales_order \
    WHERE id=(select sales_order_id \
      from bill_items \
      where bill_no=$1 \
      limit 1)',
        [bill_no],
        function (err, result) {
            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }
            res.send(result.rows[0]);
        });
});

router.post('/update_recovery_details/:outlet_id', function (req, res, next) {
    var bill_no = req.body.bill_no;
    var dispense_id = req.body.dispense_id;
    var outlet_id = req.params.outlet_id;

    var update_query = [];
    var columns = [];
    var values = [];
    if (bill_no != undefined) {
        update_query.push('bill_no=' + bill_no);
        columns.push('bill_no');
        values.push(bill_no);
    }

    if (dispense_id != undefined) {
        update_query.push('dispense_id=' + dispense_id);
        columns.push('dispense_id');
        values.push(dispense_id);
    }
    config.query('WITH upsert as (UPDATE outlet_crash_recovery \
    SET {} \
    WHERE outlet_id=$1 \
    RETURNING * ) \
  INSERT into outlet_crash_recovery ({},outlet_id) \
  SELECT {},$1 \
  WHERE not exists (select * from upsert);'.format(
        update_query.join(','),
        columns.join(','),
        values.join(',')),
        [outlet_id], function (err, result) {
            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }
            res.send('success');
        });
});

router.get('/get_recovery_details/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    config.query('SELECT bill_no, dispense_id \
    FROM outlet_crash_recovery \
    WHERE outlet_id=$1',
        [outlet_id], function (err, result) {
            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }
            res.send(result.rows[0]);
        });
});

router.get('/dispenser_queue/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    config.query('SELECT bill_no, si.food_item_id,si.quantity,si.barcode \
    FROM bill_items b, sales_order s, sales_order_items si \
    WHERE b.sales_order_id=s.id and si.sales_order_id=s.id \
    and s.time > (now() - interval \'24 hours\') \
    and s.outlet_id=$1 and dispense_status <> \'delivered\'',
        [outlet_id], function (err, result) {
            if (err) {
                console.error(err);
                return res.status(500).send(err);
            }
            res.send(result.rows);
        });
});

//router.get('/get_live_pos/:outlet_id', function (req, res, next) {
//    var outlet_id = req.params.outlet_id;
//    pg.connect(conString, function (err, client, done) {
//        if (err) {
//            handleError(client, done, res, 'error fetching client from pool' + err);
//            return;
//        }

//        var query = "";
//        var outlet_version = 0;

//        client.query("select version from outlet where id =$1",
//            [outlet_id],
//            function (query_err, result_outlet) {
//                if (query_err) {
//                    handleError(client, done, res, 'get_live_pos :: error running query' + query_err);
//                    return;
//                }

//                done();
//                outlet_version = result_outlet.rows[0].version;
//                console.log("outlet_version: " + outlet_version);

//                if (outlet_version != null && Number(outlet_version.toFixed(2)) != Number(process.env.OUTLETVERSION)) {
//                    query = 'SELECT count(distinct(pb.purchase_order_id)) \
//                      FROM purchase_order p, purchase_order_batch pb \
//                      WHERE p.outlet_id=$1 and p.id=pb.purchase_order_id and \
//                      p.scheduled_delivery_time::date=current_date \
//                      and pb.received_time is not null';
//                }
//                else {
//                    query = 'SELECT count(distinct(p.id)) FROM purchase_order p \
//                      WHERE p.outlet_id=$1 and p.scheduled_delivery_time::date=current_date \
//                      and p.received_time is not null';
//                }

//                client.query(query,
//                    [outlet_id],
//                    function (err, result) {
//                        if (err) {
//                            handleError(client, done, res, '/get_live_pos/:outlet_id :: error running query' + err);
//                            return;
//                        }
//                        done();
//                        res.send(result.rows[0]);
//                    });
//            });
//    });
//});

router.get('/get_live_pos/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        var query = "";
        var outlet_version = 0;

        client.query("select version from outlet where id =$1",
        [outlet_id],
        function (query_err, result_outlet) {
            if (query_err) {
                handleError(client, done, res, 'get_live_pos :: error running query' + query_err);
                return;
            }

            done();
            outlet_version = result_outlet.rows[0].version;
            console.log("outlet_version: " + outlet_version);

            if (outlet_version != null && Number(outlet_version.toFixed(2)) == 2.5) { // Only Accountability
                query = "SELECT count(distinct(p.id)) FROM purchase_order p \
                      WHERE p.outlet_id=$1 and p.scheduled_delivery_time::date=current_date \
                      and p.received_time is not null";
            }
            else if (outlet_version != null && Number(outlet_version.toFixed(2)) == 3.0) { // Accountability with Pre-Printed Barcode
                query = "SELECT count(distinct(pb.purchase_order_id)) \
                      FROM purchase_order p, purchase_order_batch pb \
                      WHERE p.outlet_id=$1 and p.id=pb.purchase_order_id and \
                      p.scheduled_delivery_time::date=current_date \
                      and pb.received_time is null";
            }
            else // Old Version (without Accountability and Pre-Printed Barcode)
            {
                query = "SELECT count(distinct(pb.purchase_order_id)) \
                          FROM purchase_order p, purchase_order_batch pb \
                          WHERE p.outlet_id=$1 and p.id=pb.purchase_order_id and \
                          p.scheduled_delivery_time::date=current_date \
                          and pb.received_time is not null";
            }

            client.query(query,
              [outlet_id],
              function (err, result) {
                  if (err) {
                      handleError(client, done, res, '/get_live_pos/:outlet_id :: error running query' + err);
                      return;
                  }
                  done();
                  res.send(result.rows[0]);
              });
        });
    });
});

router.get('/order_details/:order_id', function (req, res, next) {
    var order_id = req.params.order_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('SELECT f.name, coalesce(i.quantity, b.quantity) as quantity, \
      b.quantity as original_quantity, mrp,side_order, (select bill_no from bill_items where sales_order_id=$1 limit 1), \
      r.name as rest_name,r.id as rest_id,r.tin_no,r.st_no, \
      coalesce(i.barcode,\'\') barcode \
      FROM  food_item f, restaurant r, bill_items b full outer join \
      sales_order_items i on b.sales_order_id=i.sales_order_id and \
      b.food_item_id=i.food_item_id \
      WHERE coalesce(i.food_item_id,b.food_item_id)=f.id \
      and f.restaurant_id=r.id \
      and coalesce(i.sales_order_id,b.sales_order_id)=$1', [order_id],
            function (err, result) {
                if (err) {
                    handleError(client, done, res, '/order_details/:order_id :: error running query' + err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

router.post('/update_dispense_status', function (req, res, next) {
    var dispense_status_data = req.body.data;
    var outlet_id = req.body.outlet_id;
    debug("Received dispense data as- ", JSON.stringify(dispense_status_data));
    for (var bill_no in dispense_status_data) {
        // update bill_items table with the appropriate bill_no and status
        config.query('UPDATE bill_items \
      set dispense_status=$1 \
      where bill_no=$2 \
      and sales_order_id=(select max(id) \
        from sales_order s, bill_items b \
        where s.id=b.sales_order_id \
        and s.outlet_id=$3 \
        and b.bill_no=$2 )',
            [dispense_status_data[bill_no], bill_no, outlet_id],
            function (err, result) {
                if (err) {
                    console.error(err);
                    return;
                }
                debug("Updated dispense status for ", result.rows.length, " rows");
            });
    }
    res.send('success');
});

// This returns the user groups for the outlet to know where to send a message
router.get('/get_user_groups', function (req, res, next) {
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        // update bill_items table with the appropriate bill_no and status
        client.query('SELECT enum_range(NULL::user_role)',
            function (err, result) {
                if (err) {
                    handleError(client, done, res, '/get_user_groups :: error running query' + err);
                    return;
                }
                done();
                res.send(result.rows[0].enum_range);
            });
    });
});

// These handlers are for displaying data in the outlet dash
router.get('/show_orders/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var time = req.query.time;
    if (time == 'now') {
        var time_query = 'time > (now() - interval \'24 hours\')';
    } else {
        var time_query = 'time::date = \'' + time + '\'';
    }

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('SELECT id,time,method,amount_due,dispense_status,bill_nos,mobile_num \
      FROM sales_order s, \
      (SELECT sales_order_id, sum(amount_due) as amount_due \
        FROM sales_order s, sales_order_payments p \
        WHERE s.id=p.sales_order_id and {0}\
        GROUP BY p.sales_order_id) s_amount, \
    (SELECT sales_order_id, array_agg(distinct(bill_no)) as bill_nos, \
      array_agg(distinct(dispense_status)) as dispense_status \
      FROM bill_items b, sales_order s \
      WHERE s.id=b.sales_order_id and {0}\
      GROUP BY sales_order_id) bill \
    WHERE s.id=s_amount.sales_order_id and s.id=bill.sales_order_id and {0} and outlet_id=$1 order by s.id desc'.format(time_query),
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/show_orders/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result.rows);
            });

    });
});

router.get('/show_bill_items/:id', function (req, res, next) {
    var order_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT (select bill_no from bill_items where sales_order_id=$1 limit 1), \
     coalesce(i.quantity, b.quantity) as quantity, b.quantity as original_quantity, \
     f.id, f.name, f.mrp,  coalesce(i.barcode,\'\') barcode \
     FROM bill_items b full outer join \
     sales_order_items i on b.sales_order_id=i.sales_order_id and \
     b.food_item_id=i.food_item_id, food_item f \
     WHERE coalesce(i.food_item_id,b.food_item_id)=f.id and \
     coalesce(i.sales_order_id,b.sales_order_id)=$1 \
     ORDER BY bill_no asc',
            [order_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/show_bill_items/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result.rows);
            });

    });
});

// This handler is used to refund items
router.post('/refund_items/:id', function (req, res, next) {
    var order_id = req.params.id;
    var amount = req.body.amount;
    var item_details = req.body.item_details;
    config.query('INSERT INTO sales_order_payments \
    VALUES ($1, $2, $2, \'refund\', \'modified\')',
        [order_id, -parseInt(amount)],
        function (query_err, result) {
            if (query_err) {
                console.error(query_err);
                res.status(500).send(query_err);
                return;
            }

            for (var barcode in item_details) {
                config.query('INSERT INTO sales_order_items \
          VALUES ($1, $2, $3, $4)',
                    [order_id, getItemId(barcode), -item_details[barcode], barcode],
                    function (items_err, items_result) {
                        if (items_err) {
                            console.error(query_err);
                            return;
                        }
                    });
            }
            res.send(result.rows);
        });
});

// This handler is used to replace items
router.post('/replace_items/:id', function (req, res, next) {
    var order_id = req.params.id;
    var amount = req.body.amount;
    var replaced_amount = req.body.replaced_amount;
    var item_details = req.body.item_details;
    var replaced_item_details = req.body.replaced_item_details;

    updateSalesOrderPayments(order_id, amount, replaced_amount, res);

    for (var barcode in item_details) {
        config.query('INSERT INTO sales_order_items \
      VALUES ($1, $2, $3, $4)',
            [order_id, getItemId(barcode), -item_details[barcode], barcode],
            function (items_err, items_result) {
                if (items_err) {
                    console.error(items_err);
                    return;
                }
            });
    }

    for (var barcode in replaced_item_details) {
        config.query('INSERT INTO sales_order_items \
      VALUES ($1, $2, $3, $4)',
            [order_id, getItemId(barcode), replaced_item_details[barcode], barcode],
            function (items_err, items_result) {
                if (items_err) {
                    console.error(items_err);
                    return;
                }
            });
    }
    res.send('success');
});

// This is to update the inventory after removing the expired items
router.post('/remove_expired_items', function (req, res, next) {
    var barcodes = req.body.barcodes;
    updateFinalStatus(res, 'expired', barcodes, null);
});

// This is to update the inventory after removing the unscanned items
router.post('/remove_unscanned_items', function (req, res, next) {
    // This will take item ids and then update the barcodes
    var barcodes = req.body.barcodes;
    updateFinalStatus(res, 'unable to scan (Rest. fault)', barcodes, null);
});

// This is to update the po final status for marking loading issue items
router.post('/report_loading_issue/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    var item_id_info = req.body.item_id_info;
    for (var i = 0; i < item_id_info.length; i++) {
        (function (i) {
            pg.connect(conString, function (err, client, done) {
                if (err) {
                    done(client);
                    console.error(msg);
                    return;
                }
                if (item_id_info[i]["qty"] == "") {
                    done();
                    return;
                }
                client.query('INSERT into purchase_order_final_status (batch_id, purchase_order_id, barcode, food_item_id, quantity, status, problem, note)\
          VALUES($1, $2, (select barcode from purchase_order_batch where purchase_order_id=$2 and id=$1 and base36_decode(substring(barcode from 9 for 4))::integer=(select id from food_item where master_id=$3 and outlet_id=$7 limit 1) limit 1), (select id from food_item where master_id=$3 and outlet_id=$7 limit 1), $4, $5::po_final_status, $5, $6)',
                    [item_id_info[i]["batch_id"], item_id_info[i]["purchase_order_id"], item_id_info[i]["item_id"], item_id_info[i]["qty"], item_id_info[i]["problem"], item_id_info[i]["note"], outlet_id],
                    function (query_err, result) {
                        if (query_err) {
                            console.error(query_err);
                        }
                        done();
                    });
            });
        })(i);
    }
    res.send('success');
});

// get all po_ids , rest_id and batch_id for that outlet
// which have received_time as null and also group them
router.get('/get_pending_to_load_items/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT pb.id as batch_id, pb.purchase_order_id, r.id as restarant_id \
      FROM purchase_order p, purchase_order_batch pb, restaurant r \
      WHERE p.id=pb.purchase_order_id and p.restaurant_id=r.id and \
      p.outlet_id=$1 and pb.received_time is null \
      GROUP BY pb.purchase_order_id, pb.id, r.id',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/get_pending_to_load_items/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

router.get('/get_loading_issue_items/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        // This should return all batches of the last PO from every restaurant
        client.query('SELECT pb.id as batch_id, (array_agg(barcode))[1] as barcode, purchase_order_id,\
      f.name, f.master_id as item_id, r.short_name \
      FROM purchase_order_batch pb, purchase_order p, \
      (SELECT max(purchase_order_id), restaurant_id \
        FROM purchase_order_batch pb, purchase_order p \
        WHERE pb.purchase_order_id=p.id group by restaurant_id) rest_group, \
    food_item f, restaurant r WHERE pb.purchase_order_id=p.id AND \
    f.id=base36_decode(substring(barcode from 9 for 4))::integer AND \
    purchase_order_id=rest_group.max AND \
    f.location=\'dispenser\' AND \
    p.scheduled_delivery_time::date=current_date AND \
    p.restaurant_id=r.id AND \
    f.restaurant_id=r.id AND \
    p.restaurant_id=rest_group.restaurant_id and p.outlet_id=$1 \
    GROUP BY batch_id, purchase_order_id,f.name,item_id,short_name \
    ORDER BY short_name,item_id',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'get_loading_issue_items :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// This is to update the po final status for markihg customer issue items
router.post('/report_customer_issue', function (req, res, next) {
    var barcodes = req.body.barcodes;
    var misc_notes = req.body.misc_notes;
    updateFinalStatus(res, 'customer_issue', barcodes, misc_notes);
});

// This is to update the po final status for marking the spoiled items
router.post('/report_spoilage', function (req, res, next) {
    var barcodes = req.body.barcodes;
    var misc_notes = req.body.misc_notes;
    updateFinalStatus(res, 'spoiled', barcodes, misc_notes);
});

// This is to mark all standing PO for the outlet as spoiled.
router.post('/force_failure', function (req, res, next) {
    var outlet_id = req.body.outlet_id;
    var barcodes = req.body.barcodes;
    var misc_notes = req.body.misc_notes;
    var fail_all = req.body.fail_all;
    console.log("outlet id: " + outlet_id);
    console.log("fail all: " + fail_all);
    console.log("barcodes: " + barcodes);
    if (fail_all) {
        dbUtils.getAllBarcodesForManualFailure(outlet_id, function (err, unloaded_barcodes) {
            if (err) {
                console.error(err);
                res.status(500).send(err);
            }
            debugger;
            var all_barcodes = [];
            _.each(unloaded_barcodes, function (row) {
                for (var i = 0; i < row.quantity; i++) {
                    all_barcodes.push(row.barcode);
                }
            });
            updateFinalStatus(res, 'scanner fault (Foodbox fault)', all_barcodes, misc_notes);
        });
    } else {
        updateFinalStatus(res, 'scanner fault (Foodbox fault)', barcodes, misc_notes);
    }
});

router.post('/signal_po_batch_arrival', function (req, res, next) {
    var purchase_order_id = req.body.purchase_order_id;
    var batch_id = req.body.batch_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('UPDATE purchase_order_batch \
      SET delivery_time=now() \
      WHERE id=$1 and purchase_order_id=$2',
            [batch_id, purchase_order_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/signal_po_batch_arrival :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

// This logs the quantity of different kinds of supplies at sod and eod
router.post('/supplies_status', function (req, res, next) {
    var phase = req.query.phase;
    var supplies = req.body.supplies;

    for (var item_id in supplies) {
        config.query('INSERT INTO supplies \
      VALUES ($1, $2, now(), $3)',
            [item_id, supplies[item_id], phase],
            function (err, result) {
                if (err) {
                    console.error(err);
                    return;
                }
            });
    }
    res.send('success');
});

router.get('/unscanned_barcodes/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    // select from purchase_order, purchase_order_batch, purchase_order_final_status
    // first get the batch id of the second last purchase_order_id and match that
    // then get all barcodes which is not in final_status
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('INSERT INTO supplies \
      VALUES ($1, $2, now(), $3)',
            [item_id, supplies[item_id], phase],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/unscanned_barcodes/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

//router.get('/get_outstanding_po/:id', function (req, res, next) {
//    var outlet_id = req.params.id;
//    var show_incoming_po_time = process.env.SHOWINCOMINGPO;
//    console.log("show_incoming_po_time: " + show_incoming_po_time);
//    pg.connect(conString, function (err, client, done) {
//        if (err) {
//            handleError(client, done, res, 'error fetching client from pool' + err);
//            return;
//        }        

//        var query = "";
//        var outlet_version = 0;

//        client.query("select version from outlet where id =$1",
//            [outlet_id],
//            function (query_err, result_outlet) {
//                if (query_err) {
//                    handleError(client, done, res, 'get_outstanding_po :: error running query' + query_err);
//                    return;
//                }

//                done();
//                outlet_version = result_outlet.rows[0].version;
//                console.log("outlet_version: " + outlet_version);

//                if (outlet_version != null && Number(outlet_version.toFixed(2)) != Number(process.env.OUTLETVERSION)) {
//                    query = 'SELECT sq.batch_id, sq.purchase_order_id as po_id, \
//          sq.count as items, sq.sum as qty, sq.scheduled_time, \
//          sq.restaurant_id as r_id, r.name as rest_name \
//          FROM restaurant r, \
//          (select pb.id as batch_id, pb.purchase_order_id, count(distinct(base36_decode(substring(pb.barcode from 9 for 4)))), \
//            sum(pb.quantity), (array_agg(p.scheduled_delivery_time))[1] as scheduled_time, p.restaurant_id \
//            FROM purchase_order p, purchase_order_batch pb, restaurant r \
//            WHERE p.id=pb.purchase_order_id and p.restaurant_id=r.id \
//            and p.outlet_id=$1 \
//            and p.scheduled_delivery_time::date=current_date \
//            and pb.received_time is null \
//            GROUP BY pb.id, pb.purchase_order_id, p.restaurant_id) sq \
//        WHERE sq.restaurant_id=r.id';
//                }
//                else {
//                    query = "select po.id as po_id, po.scheduled_delivery_time as scheduled_time, po.restaurant_id as r_id \
//        , r.name as rest_name, sum(poi.quantity) as qty, count(poi.purchase_order_id) as items \
//        from purchase_order po \
//        join purchase_order_master_list poi on po.id = poi.purchase_order_id \
//        join restaurant r on po.restaurant_id = r.id \
//        where outlet_id = $1 and po.scheduled_delivery_time::date=current_date \
//        and now() + interval '" + show_incoming_po_time + " minutes' >= po.scheduled_delivery_time \
//        and po.received_time is null \
//        group by po_id,rest_name \
//        order by po_id desc";
//                }
//                console.log("get_outstanding_po" + query);

//                client.query(query,
//                    [outlet_id],
//                    function (query_err, result) {
//                        if (query_err) {
//                            handleError(client, done, res, 'get_outstanding_po :: error running query' + query_err);
//                            return;
//                        }
//                        done();
//                        console.log("get_outstanding_po: " + JSON.stringify(result.rows));
//                        res.send(result.rows);
//                    });
//            });
//    });
//});

router.get('/get_outstanding_po/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var show_incoming_po_time = process.env.SHOWINCOMINGPO;
    console.log("show_incoming_po_time: " + show_incoming_po_time);
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        var query = "";
        var outlet_version = 0;

        client.query("select version from outlet where id =$1",
        [outlet_id],
        function (query_err, result_outlet) {
            if (query_err) {
                handleError(client, done, res, 'get_outstanding_po :: error running query' + query_err);
                return;
            }

            done();
            outlet_version = result_outlet.rows[0].version;
            console.log("outlet_version: " + outlet_version);

            if (outlet_version != null && Number(outlet_version.toFixed(2)) == 2.5) { // Only Accountability
                query = "select po.id as po_id, po.scheduled_delivery_time as scheduled_time, po.restaurant_id as r_id \
                ,r.name as rest_name, poi.food_item_id, fi.item_tag,fi.name as item_name, poi.quantity as qty \
                ,fi.master_id , m.start_time,m.end_time,m.name session_name \
                from purchase_order po \
                join purchase_order_master_list poi on po.id = poi.purchase_order_id \
                join restaurant r on po.restaurant_id = r.id \
                join food_item fi on fi.id = poi.food_item_id \
                inner join menu_bands m on m.outlet_id =po.outlet_id \
                where po.outlet_id = $1 and po.scheduled_delivery_time::date=current_date \
                and now() + interval '" + show_incoming_po_time + " minutes' >= po.scheduled_delivery_time \
                and poi.received_time is null \
                and po.scheduled_delivery_time::time>=m.start_time \
                and po.scheduled_delivery_time::time<= m.end_time\
                order by po_id desc";

                console.log("********** get_outstanding_po :: Only Accountability query called: ********** " + query);
            }
            else if (outlet_version != null && Number(outlet_version.toFixed(2)) == 3.0) { // Accountability with Pre-printed Barcode        
                query = "SELECT sq.batch_id, sq.purchase_order_id as po_id,\
                sq.count as items, sq.sum as qty, sq.scheduled_time,\
                sq.restaurant_id as r_id, r.name as rest_name, sq.po_received_time , sq.received_time \
                FROM restaurant r, \
                (select pb.id as batch_id, pb.purchase_order_id, count(distinct(base36_decode(substring(pb.barcode from 9 for 4)))),\
                sum(pb.quantity), (array_agg(p.scheduled_delivery_time))[1] as scheduled_time, p.restaurant_id, p.po_received_time, p.received_time \
                FROM purchase_order p, purchase_order_batch pb, restaurant r \
                WHERE p.id=pb.purchase_order_id and p.restaurant_id=r.id \
                and p.outlet_id=$1 \
                and p.scheduled_delivery_time::date=current_date \
                and now() + interval '" + show_incoming_po_time + " minutes' >= p.scheduled_delivery_time \
                and p.received_time is null \
                GROUP BY pb.id, pb.purchase_order_id, p.restaurant_id, p.po_received_time, p.received_time ) sq \
                WHERE sq.restaurant_id=r.id";
                console.log("********** get_outstanding_po :: Accountability with Pre-printed Barcode query called: ********** " + query);
            }
            else // Old version (without Accountability and Pre-printed Barcode)
            {
                query = 'SELECT sq.batch_id, sq.purchase_order_id as po_id, \
                sq.count as items, sq.sum as qty, sq.scheduled_time, \
                sq.restaurant_id as r_id, r.name as rest_name \
                FROM restaurant r, \
                (select pb.id as batch_id, pb.purchase_order_id, count(distinct(base36_decode(substring(pb.barcode from 9 for 4)))), \
                sum(pb.quantity), (array_agg(p.scheduled_delivery_time))[1] as scheduled_time, p.restaurant_id \
                FROM purchase_order p, purchase_order_batch pb, restaurant r \
                WHERE p.id=pb.purchase_order_id and p.restaurant_id=r.id \
                and p.outlet_id=$1 \
                and p.scheduled_delivery_time::date=current_date \
                and pb.received_time is null \
                GROUP BY pb.id, pb.purchase_order_id, p.restaurant_id) sq \
                WHERE sq.restaurant_id=r.id';

                console.log("********** get_outstanding_po :: Old version query called (without Accountability and Pre-printed Barcode): ********** " + query);
            }


            client.query(query,
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'get_outstanding_po :: error running query' + query_err);
                    return;
                }
                done();
                console.log("get_outstanding_po: " + JSON.stringify(result.rows));
                res.send(result.rows);
            });
        });
    });
});

router.get('/get_last_load_items/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var last_load_info = JSON.parse(req.query.last_load_info);

    var query_string = [];
    for (var i = 0; i < last_load_info.length; i++) {
        if (Object.keys(last_load_info[i]).length == 0) {
            continue;
        }
        if (last_load_info[i]["batch_id"] != undefined && last_load_info[i]["batch_id"] != "") {
            query_string.push('(pb.id={} and purchase_order_id={})'.format(last_load_info[i]["batch_id"], last_load_info[i]["po_id"]));
        }
        else {
            debug("Batch Id is Missing :" + last_load_info[i]["batch_id"])
        }
    }
    if (query_string.length == 0) {
        return res.send([]);
    }

    query_string = query_string.join(' or ');
    query_string = 'select pb.id as batch_id, (array_agg(barcode))[1] as barcode, \
  purchase_order_id, f.name, f.master_id as item_id, r.short_name \
  from purchase_order_batch pb, food_item f, purchase_order p, restaurant r \
  where f.location=\'dispenser\' \
  and pb.purchase_order_id=p.id and f.restaurant_id=r.id and p.restaurant_id = r.id \
  and p.scheduled_delivery_time > (now() - interval \'24 hours\') \
  and f.id=base36_decode(substring(barcode from 9 for 4))::integer \
  and (' + query_string + ') \
  group by pb.id, purchase_order_id, f.name, r.short_name, f.master_id \
  order by short_name, item_id';

    console.log("/get_last_load_items/:id :: query_string :: " + query_string);
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query(query_string,
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/get_last_load_items/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

router.post('/update_unscanned_items', function (req, res, next) {
    // item_id_info is a list of dicts{item_id, purchase_order_id, batch_id, qty}
    var item_id_info = req.body.item_id_info;
    for (var i = 0; i < item_id_info.length; i++) {
        (function (i) {
            pg.connect(conString, function (err, client, done) {
                if (err) {
                    done(client);
                    console.error(msg);
                    return;
                }
                client.query('INSERT into purchase_order_final_status (batch_id, purchase_order_id, barcode, food_item_id, quantity, status, problem, note)\
          VALUES($1, $2, (select barcode from purchase_order_batch where purchase_order_id=$2 and id=$1 and base36_decode(substring(barcode from 9 for 4))::integer=$3), $3, $4, \'unscanned\', \'\', \'\')', [item_id_info[i]["batch_id"], item_id_info[i]["purchase_order_id"], item_id_info[i]["item_id"], item_id_info[i]["qty"]],
                    function (query_err, result) {
                        if (query_err) {
                            console.error(msg);
                        }
                        done();
                    });
            });
        })(i);
    }
    res.send('success');
});

router.post('/update_received_time/:id', function (req, res, next) {
    var outlet_id = req.params.id;

    var rest_id = req.body.rest_id;
    var po_id = req.body.po_id;
    var batch_id = req.body.batch_id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('UPDATE purchase_order_batch SET received_time = now() \
        WHERE purchase_order_id=$1',
            [po_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/update_received_time/:id :: error running query' + query_err);
                    return;
                }

                done();
            });

        // new field received_time updatation in purchase_order table
        client.query('UPDATE purchase_order SET received_time = now() \
      WHERE id=$1',
            [po_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/update_received_time/:id 1 :: error running query :: UPDATE purchase_order :' + query_err);
                    return;
                }
                done();
            });
        res.send('success');


    });

});

// This calls a db function which performs the eod calcualation
router.post('/eod_calc/:outlet_id', function (req, res, next) {
    console.log("*************************************** function called");
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        console.log("*************************************** pg connect called");
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        delete_mobile_pending_orders(outlet_id);

        client.query('SELECT eod_calculation($1)',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/eod_calc/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                console.log("*************************************** eod called");

                client.query("select action_time::date from outlet_register \
                where outlet_id=$1 and phase='sod' order by id desc limit 1",
                    [outlet_id],
                    function (query_err, date_obj) {
                        if (query_err) {
                            handleError(client, done, res, '/eod_calc/:outlet_id 1 :: error running query' + query_err);
                            return;
                        }
                        done();
                        console.log("*************************************** outlet_reg called" + date_obj);

                        //  var date_check = result.rows[0].eod_calculation;
                        //  var date_obj = new Date();
                        //// If the eod is done past that day, rewind the time one day
                        //if (date_check == -1) {
                        //  date_obj.setDate(date_obj.getDate()-1);
                        //}
                        console.log("***************************************date_obj.rows.length" + date_obj.rows.length);
                        var cash_settlement_date = date_obj.rows.length > 0 ? date_obj.rows[0].action_time : new Date(moment().format('YYYY-MM-DD HH:mm:ss'));
                        console.log("*************************************** date object" + JSON.stringify(cash_settlement_date));
                        var requestString = 'http://127.0.0.1:' + process.env.PORT + '/cash_settlement/{}/{}/'.format(outlet_id, cash_settlement_date.yyyymmdd());
                        console.log("*************************************** requestString" + requestString);
                        request(requestString, {
                            timeout: 600000
                        }, function (error, response, body) {
                            if (error || (response && response.statusCode != 200)) {
                                console.log('{}: {} {}'.format(process.env.HQ_URL, error, body));
                                res.status(500).send(body);
                                return;
                            }
                            // Check if this is the last outlet eod in the city, then trigger FTR too
                            // /ftr/<city>/<date>
                            config.query('SELECT id,start_of_day,end_of_day,city \
          FROM outlet \
          WHERE city=(select city from outlet where id=$1)',
                                [outlet_id],
                                function (err, result) {
                                    if (err) {
                                        console.error(err);
                                        return;
                                    }
                                    var dateArray = [];
                                    result.rows.map(function (item) {
                                        var eod = parseTime(item.end_of_day);
                                        var sod = parseTime(item.start_of_day);
                                        var newDate = new Date(date_obj);
                                        if (eod > sod) {
                                            //construct date obj
                                            newDate.setHours(eod.getHours());
                                            newDate.setMinutes(eod.getMinutes());
                                            dateArray.push({ date: newDate, outlet_id: item.id, city: item.city });
                                        } else {
                                            newDate.setDate(newDate.getDate() + 1);
                                            newDate.setHours(eod.getHours());
                                            newDate.setMinutes(eod.getMinutes());
                                            dateArray.push({ date: newDate, outlet_id: item.id, city: item.city });
                                        }
                                    });

                                    // get the max of the dateArray, and check if it is the current outlet
                                    var maxOutletId = -1;
                                    var targetCity = '';
                                    var max_time = new Date('1970-01-01');
                                    dateArray.map(function (item) {
                                        if (item.date.getTime() > max_time.getTime()) {
                                            max_time = item.date;
                                            maxOutletId = item.outlet_id;
                                            targetCity = item.city;
                                        }
                                    });

                                    if (outlet_id == maxOutletId) {
                                        debug("Doing FTR call for city ", targetCity);
                                        var requestString = 'http://127.0.0.1:' + process.env.PORT +
                                            '/ftr/{}/{}/'.format(targetCity, date_obj.yyyymmdd());
                                        request(requestString, {
                                            timeout: 600000
                                        },
                                            function (error, response, body) {
                                                if (error || (response && response.statusCode != 200)) {
                                                    console.log('{}: {} {}'.format(process.env.HQ_URL, error, body));
                                                    return;
                                                }
                                            });
                                    } else {
                                        debug("Max EOD did not match for the current outlet");
                                    }
                                });
                            res.send("success");
                        });
                    });
            });
    });
});


router.get('/sample', function (req, res, next) {
    var date_obj = new Date();
    var outlet_id = 6;
    config.query('SELECT id,start_of_day,end_of_day,city \
    FROM outlet \
    WHERE city=(select city from outlet where id=$1)',
        [outlet_id],
        function (err, result) {
            if (err) {
                console.error(err);
                return;
            }
            var dateArray = [];
            result.rows.map(function (item) {
                var eod = parseTime(item.end_of_day);
                var sod = parseTime(item.start_of_day);
                var newDate = new Date(date_obj);
                if (eod > sod) {
                    //construct date obj
                    newDate.setHours(eod.getHours());
                    newDate.setMinutes(eod.getMinutes());
                    dateArray.push({ date: newDate, outlet_id: item.id, city: item.city });
                } else {
                    newDate.setDate(newDate.getDate() + 1);
                    newDate.setHours(eod.getHours());
                    newDate.setMinutes(eod.getMinutes());
                    dateArray.push({ date: newDate, outlet_id: item.id, city: item.city });
                }
            });

            // get the max of the dateArray, and check if it is the current outlet
            var maxOutletId = -1;
            var targetCity = '';
            var max_time = new Date('1970-01-01');
            dateArray.map(function (item) {
                if (item.date.getTime() > max_time.getTime()) {
                    max_time = item.date;
                    maxOutletId = item.outlet_id;
                    targetCity = item.city;
                }
            });

            if (outlet_id == maxOutletId) {
                debug("Doing FTR call for city ", targetCity);
                var requestString = 'http://localhost:' + process.env.PORT +
                    '/ftr/{}/{}/'.format(targetCity, date_obj.yyyymmdd());
                request(requestString, { timeout: 600000 },
                    function (error, response, body) {
                        if (error || (response && response.statusCode != 200)) {
                            console.log('{}: {} {}'.format(process.env.HQ_URL, error, body));
                            return;
                        }
                    });
            } else {
                debug("Max EOD did not match for the current outlet");
            }
        });
    res.send("success");
});

// This is to get the list of food item issues to show in the outlet dash
router.get('/food_item_issues/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    var time = req.query.time;
    if (time == 'now') {
        var time_query = 'p.green_signal_time > (now() - interval \'1 day\')';
    } else {
        var time_query = 'p.green_signal_time::date = \'' + time + '\'';
    }
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT f.name,pf.status as problem,pf.note,p.green_signal_time \
      FROM purchase_order_final_status pf, purchase_order p, food_item f \
      WHERE p.id=pf.purchase_order_id and f.id=pf.food_item_id and {} and p.outlet_id=$1 and (pf.status=\'damaged in transit\' OR pf.status=\'damaged while dispensing\' OR pf.status=\'unable to scan (Rest. fault)\' \
        OR pf.status=\'loading_issue\' OR pf.status=\'scanner fault (Foodbox fault)\' OR pf.status=\'improperly sealed\' \
        OR pf.status=\'quantity\' OR pf.status=\'quality\' OR pf.status=\'spoiled\' OR pf.status=\'other\')'.format(time_query),
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/food_item_issues/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// This is to get the list of non food item issues to show in the outlet dash
router.get('/non_food_item_issues/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    var time = req.query.time;
    if (time == 'now') {
        var time_query = 'time > (now() - interval \'1 day\')';
    } else {
        var time_query = 'time::date = \'' + time + '\'';
    }
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select type, note, time from non_food_issue where outlet_id=$1 and {}'.format(time_query),
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/non_food_item_issues/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// This is to show the list of barcodes for reporting food item issues
router.get('/food_item_list/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        // This returns the barcodes after the end_of_day of the supplies for
        // that outlet
        client.query('SELECT pb.id as batch_id, barcode, p.id as purchase_order_id, \
      f.name, base36_decode(substring(barcode from 9 for 4))::integer as item_id \
      FROM purchase_order_batch pb, purchase_order p, food_item f \
      WHERE pb.purchase_order_id=p.id AND base36_decode(substring(barcode from 9 for 4))::integer=f.id \
      AND f.outlet_id=$1 AND p.green_signal_time::date=current_date \
      AND pb.received_time is not null',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/food_item_list/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// Return the enum of non_food_types to show in the drop down
router.get('/non_food_types', function (req, res, next) {
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('SELECT enum_range(NULL::non_food_issue_types)',
            function (err, result) {
                if (err) {
                    handleError(client, done, res, '/non_food_types :: error running query' + err);
                    return;
                }
                done();
                res.send(result.rows[0].enum_range);
            });
    });
});

router.get('/reconcile_remarks', function (req, res, next) {
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        client.query('SELECT enum_range(NULL::reconcile_remarks)',
            function (err, result) {
                if (err) {
                    handleError(client, done, res, '/reconcile_remarks :: error running query' + err);
                    return;
                }
                done();
                res.send(result.rows[0].enum_range);
            });
    });
});

// This is to update the item issues for both food and non-food
router.post('/update_item_issues/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    var barcode_details = req.body.barcode_details;
    var non_food_issue = req.body.non_food_issue;
    for (var i = 0; i < barcode_details.length; i++) {
        (function (i) {
            pg.connect(conString, function (err, client, done) {
                if (err) {
                    done(client);
                    console.error(msg);
                    return;
                }
                client.query('WITH batch_details as ( \
          SELECT pb.id, purchase_order_id \
          FROM purchase_order_batch pb, purchase_order p\
          WHERE p.id=pb.purchase_order_id and p.outlet_id=$1 and barcode=$2 limit 1) \
        INSERT INTO purchase_order_final_status (batch_id, purchase_order_id, barcode, food_item_id, quantity, status, problem, note)\
        SELECT batch_details.id, batch_details.purchase_order_id, \
        $2, $3, $4, $5, $6, $7 \
        FROM batch_details',
                    [outlet_id, barcode_details[i]["barcode"], getItemId(barcode_details[i]["barcode"]), barcode_details[i]["count"], barcode_details[i]["final_status"], barcode_details[i]["problem"], barcode_details[i]["note"]],
                    function (query_err, result) {
                        if (query_err) {
                            console.error(msg);
                        }
                        done();
                    });
            });
        })(i);
    }

    // This is just to check whether there is a non-food issue or not
    if (non_food_issue["type"] !== undefined) {
        pg.connect(conString, function (err, client, done) {
            if (err) {
                done(client);
                console.error(msg);
                return;
            }
            if (!non_food_issue.hasOwnProperty("reporter")) {
                non_food_issue["reporter"] = "";
            }
            client.query('INSERT INTO non_food_issue (outlet_id,type,note,reporter,time)\
        VALUES($1, $2, $3, $4, now())',
                [outlet_id, non_food_issue["type"], non_food_issue["note"], non_food_issue["reporter"]],
                function (query_err, result) {
                    if (query_err) {
                        console.error(query_err);
                    }
                    done();
                });
        });
    }
    res.send('success');
});

router.post('/test_mode_issue/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var issue_text = req.body.text;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('INSERT INTO test_mode_issue (outlet_id, issue, issue_time)\
      VALUES($1, $2, now())',
            [outlet_id, issue_text],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/test_mode_issue/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('Successfully recorded the issue');
            });
    });
});

router.post('/test_mode_time/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var start_flag_obj = req.body;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        //var column = start_flag ? "start_time" : "end_time";
        var query_string = 'INSERT INTO test_mode_issue (outlet_id, start_time, end_time) VALUES($1,$2,$3)';
        client.query(query_string, [outlet_id,start_flag_obj.start_time,start_flag_obj.endtime],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/test_mode_time/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

router.post('/test_mode_time1/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    var start_flag_obj = req.body;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        var column = start_flag ? "start_time" : "end_time";
        var query_string = 'INSERT INTO test_mode_issue (outlet_id, {}) VALUES($1, now())'.format(column);
        client.query(query_string, [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/test_mode_time/:id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

// This returns the discount percent of the customer based on his/her
// num_transactions. Also returns the total transactions and savings
router.get('/customer_details/:mobile_num', function (req, res, next) {
    var mobile_num = req.params.mobile_num;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT discount_percent, cust_details.total_expenditure, \
      cust_details.total_savings \
      FROM discount_details, \
      (SELECT total_expenditure, total_savings FROM customer_details \
        WHERE mobile_no=$1) cust_details \
    WHERE num_transactions < (SELECT num_transactions FROM customer_details \
      WHERE mobile_no=$1) \
    ORDER BY discount_percent LIMIT 1',
            [mobile_num],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/customer_details/:mobile_num :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// This updates the customer_details row for that customer, with the new
// sales and savings value and incremented the num_transactions value
router.post('/customer_details/:mobile_num', function (req, res, next) {
    var mobile_num = req.params.mobile_num;
    var total_expenditure = parseInt(req.body.total_expenditure);
    var total_savings = parseInt(req.body.total_savings);
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        // Using an upsert query because if insert if it does not exist, else update
        client.query('WITH upsert AS (UPDATE customer_details SET \
      num_transactions=num_transactions+1, \
      total_expenditure = $1, \
      total_savings = $2 WHERE mobile_no=$3 RETURNING *) \
    INSERT INTO customer_details SELECT $3, 1, $1, $2 WHERE NOT EXISTS \
    (SELECT * FROM upsert)',
            [total_expenditure, total_savings, mobile_num],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/customer_details/:mobile_num :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

// CASH / SALES section ----------------------------------------------
// This returns no. of items sold since sod for food and other items
router.get('/num_items_sold_dispenser/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT f.location, sum(si.quantity) as count \
      FROM food_item f, sales_order_items si, sales_order s, outlet o \
      WHERE s.id=si.sales_order_id and si.food_item_id=f.id \
      and s.outlet_id=o.id and f.outlet_id=o.id and s.outlet_id=$1 \
      and date_part(\'month\', s.time)=date_part(\'month\', now()) \
      and f.location=\'dispenser\' \
      GROUP BY f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/num_items_sold_dispenser/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

router.get('/num_items_sold_outside/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select f.location, sum(b.quantity) as count \
      from food_item f, sales_order s, bill_items b \
      where b.food_item_id=f.id and b.sales_order_id=s.id \
      and f.outlet_id=$1 and date_part(\'month\', s.time)=date_part(\'month\', now()) \
      and f.location=\'outside\' group by f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/num_items_sold_outside/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

// This returns the amount sold through cash since sod
router.get('/amount_for_month/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT cash_at_start as sum from outlet where id=$1',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_for_month/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

// This returns the amount sold in petty cash for that month
router.get('/amount_sold_pettycash/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT coalesce(sum(amount),0) as sum from petty_cash c, outlet o \
      WHERE date_part(\'month\', time)=date_part(\'month\', now()) \
      and c.outlet_id=o.id and o.id=$1',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_sold_pettycash/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

// This returns the amount sold in petty cash since sod
router.get('/petty_cash_breakdown/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT amount, note, time \
      FROM petty_cash \
      WHERE outlet_id=$1 and  date_part(\'month\', time)=date_part(\'month\', now()) \
      ORDER by time desc',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/petty_cash_breakdown/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

// This returns amount sold in food and snacks/drinks in that month
// Added additional filter method=cash, to show only cash amount - 14.03.2016 - Gunaseelan
router.get('/amount_sold_month_dispenser/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select f.location, sum(f.mrp*si.quantity) as sum from food_item f, \
      sales_order_items si, sales_order s where s.id=si.sales_order_id and \
      si.food_item_id=f.id and s.method=\'cash\' and s.outlet_id=f.outlet_id and s.outlet_id=$1 \
      and date_part(\'month\', s.time)=date_part(\'month\', now()) and \
      f.location=\'dispenser\' group by f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_sold_month_dispenser/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

// This returns amount sold in food in that day in cash
//-----------------------------------------------------
// Added additional filter method=cash, to show only cash amount - 14.03.2016 - Gunaseelan
router.get('/amount_sold_day_dispenser/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select f.location, sum(f.mrp*si.quantity) as sum from food_item f, \
      sales_order_items si, sales_order s where s.id=si.sales_order_id and \
      si.food_item_id=f.id and s.outlet_id=f.outlet_id and s.outlet_id=$1 \
       and s.method=\'cash\' and  s.time > (select max(time) \
        from supplies s, supplies_master_list m \
        where s.phase=\'start_of_day\' \
        and s.food_item_id=m.food_item_id and m.outlet_id=$1) \
    and f.location=\'dispenser\' group by f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_sold_day_dispenser/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});

// Added additional filter method=cash, to show only cash amount - 14.03.2016 - Gunaseelan

router.get('/amount_sold_month_outside/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select f.location, sum(mrp*b.quantity) as sold, \
      (select sum(f.mrp*si.quantity) as refund from food_item f, \
        sales_order_items si, sales_order s where s.id=si.sales_order_id \
        and si.food_item_id=f.id and s.method=\'cash\' and s.outlet_id=f.outlet_id and \
        s.outlet_id=$1 and date_part(\'month\', s.time)=date_part(\'month\', now()) \
        and f.location=\'outside\' group by f.location) \
    from food_item f, sales_order s, bill_items b \
    where b.food_item_id=f.id and b.sales_order_id=s.id \
    and f.outlet_id=$1 and date_part(\'month\', s.time)=date_part(\'month\', now()) \
    and f.location=\'outside\' group by f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_sold_month_outside/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                var nos = result.rows[0];
                if (nos == undefined) {
                    res.send({ "location": "outside", "sum": 0 });
                } else {
                    var total = nos.sold + nos.refund;
                    res.send({ "location": "outside", "sum": total });
                }
            });
    });
});

router.get('/amount_sold_day_outside/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select f.location, sum(mrp*b.quantity) as sold, \
      (select sum(f.mrp*si.quantity) as refund from food_item f, \
        sales_order_items si, sales_order s where s.id=si.sales_order_id \
        and si.food_item_id=f.id and s.outlet_id=f.outlet_id and \
        s.method=\'cash\' and \
        s.outlet_id=$1 and s.time > (select max(time) from supplies s,  \
          supplies_master_list m where s.phase=\'start_of_day\' and \
          s.food_item_id=m.food_item_id and m.outlet_id=$1) \
    and f.location=\'outside\' group by f.location) \
    from food_item f, sales_order s, bill_items b \
    where b.food_item_id=f.id and b.sales_order_id=s.id \
    and s.method=\'cash\' \
    and f.outlet_id=$1 and s.time > (select max(time) from supplies s, \
      supplies_master_list m where s.phase=\'start_of_day\' \
      and s.food_item_id=m.food_item_id and m.outlet_id=$1) \
    and f.location=\'outside\' group by f.location',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/amount_sold_day_outside/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                var nos = result.rows[0];
                if (nos == undefined) {
                    res.send({ "location": "outside", "sum": 0 });
                } else {
                    var total = nos.sold + nos.refund;
                    res.send({ "location": "outside", "sum": total });
                }
            });
    });
});


// end CASH / SALES section -----------------------------------
router.post('/petty_expenditure/:outlet_id', function (req, res, next) {
    var expenditure = req.body.data;
    var outlet_id = req.params.outlet_id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('INSERT INTO petty_cash \
      VALUES($1, $2, $3, now())',
            [expenditure.amount, expenditure.note, outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/petty_expenditure/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

router.get('/staff_roster/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('SELECT id,full_name as username,coalesce(shift,\'shift_end\') as shift \
      FROM ( \
        select u.id, full_name \
        from atp_user u, user_group g \
        where g.name=\'outlet\' and g.target_id=$1 and u.group_id=g.id) main \
    left join (\
      select us.user_id,us.shift from atp_user_shifts us, \
      (select user_id, max(time) from atp_user_shifts group by user_id) gg \
      WHERE us.user_id=gg.user_id and us.time=gg.max) gs on main.id=gs.user_id',
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/staff_roster/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send(result.rows);
            });
    });
});

router.post('/staff_roster/:outlet_id', function (req, res, next) {
    var staff_info = req.body.data;
    var outlet_id = req.params.outlet_id;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('INSERT INTO atp_user_shifts \
      VALUES($1, $2, now())',
            [staff_info.user_id, staff_info.shift],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/staff_roster/:outlet_id :: error running query' + query_err);
                    return;
                }
                done();
                res.send('success');
            });
    });
});

router.post('/stock_data/:outlet_id', function (req, res, next) {
    var item_data = req.body.item_data;
    var outlet_id = req.params.outlet_id;
    config.query('INSERT INTO live_stock \
    (outlet_id, time) \
    VALUES ($1, date_trunc(\'hour\', now())) \
    RETURNING id',
        [outlet_id], function (err, result) {
            if (err) {
                console.error(err);
                res.status(500).send(err);
                return;
            }
            var live_stock_id = result.rows[0].id;
            // Inserting the po data
            item_data.map(function (row) {
                config.query('INSERT INTO live_stock_items \
          VALUES ($1, $2, $3)',
                    [live_stock_id, row.food_item_id, row.count],
                    function (err, result) {
                        if (err) {
                            console.error(err);
                            res.status(500).send(err);
                            return;
                        }
                    });
            });
            res.send('success');
        });
});


// CASH / SALES section ----------------------------------------------

router.get('/getcashcard_sales_daymonth/:outlet_id', function (req, res, next) {
    var outlet_id = req.params.outlet_id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select cc.outlet_id,cc.month_total,cc.day_total,cc.month_cash_amount,cc.month_card_amount,cc.month_sodexocard_amount,cc.month_sodexocoupon_amount,cc.month_credit_amount,cc.month_gprscard_amount,cc.day_cash_amount,cc.day_card_amount,cc.day_sodexocard_amount, \
cc.day_sodexocoupon_amount,cc.day_credit_amount,cc.day_gprscard_amount,beverage.outlet_id,dispenser.dispenser_month_count,beverage.outside_month_count,\
dispenser.dispenser_month_amount,beverage.outside_month_amount,dispenser.dispenser_day_count,beverage.outside_day_count,dispenser.dispenser_day_amount, \
beverage.outside_day_amount from ( select $1::integer as outlet_id,sum( amount_collected) as month_total,sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\')) then amount_collected else 0 end )as day_total, \
sum( case when method=\'cash\' then amount_collected else 0 end) as month_cash_amount,\
sum( case when method=\'card\' then amount_collected else 0 end) as month_card_amount, \
sum( case when method=\'sodexocard\' then amount_collected else 0 end) as month_sodexocard_amount, \
sum( case when method=\'sodexocoupon\' then amount_collected else 0 end) as month_sodexocoupon_amount, \
sum( case when method=\'credit\' then amount_collected else 0 end) as month_credit_amount, \
sum( case when method=\'gprscard\' then amount_collected else 0 end) as month_gprscard_amount,\
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'cash\' ) then amount_collected else 0 end )as day_cash_amount, \
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'card\' ) then amount_collected else 0 end ) as day_card_amount, \
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'sodexocard\' ) then amount_collected else 0 end )as day_sodexocard_amount, \
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'sodexocoupon\' ) then amount_collected else 0 end ) as day_sodexocoupon_amount , \
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'credit\' ) then amount_collected else 0 end )as day_credit_amount, \
sum(case when (to_char(time,\'DD\')= to_char(now(),\'DD\') and method=\'gprscard\' ) then amount_collected else 0 end ) as day_gprscard_amount \
from sales_order s, sales_order_payments p, outlet o where  \
s.id=p.sales_order_id and s.outlet_id=o.id and  to_char(time,\'MMYYYY\') = to_char(now(),\'MMYYYY\') and outlet_id=$1 ) as cc \
join (select $1::integer as outlet_id,sum(case when f.location=\'dispenser\'  then si.quantity else 0 end)  as dispenser_month_count, \
sum(case when f.location=\'dispenser\'  then f.mrp*si.quantity else 0 end)  as dispenser_month_amount,  \
sum(case when f.location=\'outside\'  then f.mrp*si.quantity else 0 end)  as outside_month_amount, \
sum(case when f.location=\'dispenser\' and to_char(time,\'DD\')=to_char(now(),\'DD\') then si.quantity else 0 end)  as dispenser_day_count,\
sum(case when f.location=\'dispenser\' and to_char(time,\'DD\')=to_char(now(),\'DD\') then f.mrp*si.quantity else 0 end)  as dispenser_day_amount \
from sales_order_items si inner join  food_item f on   si.food_item_id=f.id \
inner join  sales_order s on si.sales_order_id=s.id and s.outlet_id=f.outlet_id \
where s.outlet_id=$1 \
and to_char(time,\'MMYYYY\') = to_char(now(),\'MMYYYY\') \
) as dispenser  on cc.outlet_id=dispenser.outlet_id \
join \
( \
select $1::integer as outlet_id, \
sum(case when f.location=\'outside\'  then bi.quantity else 0 end)  as outside_month_count,\
sum(case when f.location=\'outside\'  then f.mrp*bi.quantity else 0 end)  as outside_month_amount,\
sum(case when f.location=\'outside\' and to_char(time,\'DD\')=to_char(now(),\'DD\') then bi.quantity else 0 end)  as outside_day_count, \
sum(case when f.location=\'outside\' and to_char(time,\'DD\')=to_char(now(),\'DD\') then f.mrp*bi.quantity else 0 end)  as outside_day_amount \
from bill_items bi \
inner join  food_item f on   bi.food_item_id=f.id \
inner join  sales_order s  on bi.sales_order_id =s.id and bi.food_item_id=f.id \
where s.outlet_id=$1 \
and to_char(time,\'MMYYYY\') = to_char(now(),\'MMYYYY\') ) as beverage \
on beverage.outlet_id=dispenser.outlet_id' ,
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'error running query 2 :' + query_err);
                    return;
                }
                done();
                res.send(result.rows[0]);
            });
    });
});


// This handler stores the bill details and reference no in users_history table
router.post('/save_pending_orders', function (req, res, next) {
    general.genericError("save_pending_orders: " + JSON.stringify(req.body));
    var bill_no = req.body.bill_no;
    var outletid = req.body.outletid;
    var mobileno = req.body.mobileno;
    var referenceno = req.body.referenceno;
    var status = req.body.status;
    var pending_order_data;

    var previous_pending_order = {};
    var current_pending_order = {
        'bill_no': bill_no,
        'outletid': outletid,
        'mobileno': mobileno,
        'referenceno': referenceno,
        'status': status
    };

    pg.connect(conString, function (err, client, done) {
        if (err) {
            // handleError(client, done, res, 'error fetching client from pool' + err);
            console.log('save_pending_orders: Connection error fetching client from pool' + err);
            return;
        }
        client.query('select pending_orders from users_history \
      where mobileno = $1',
            [mobileno],
            function (query_err, result_pending_orders) {
                if (query_err) {
                    // handleError(client, done, res, 'error running query' + query_err);
                    console.log('save_pending_orders: select pending_orders error running query' + query_err);
                    return;
                }
                done();

                var rowslength = result_pending_orders.rows.length;
                // Insert or update users_history
                if (rowslength > 0) {
                    console.log("save_pending_orders: result_pending_orders " + JSON.stringify(result_pending_orders.rows[0]));
                    previous_pending_order = result_pending_orders.rows[0];
                    if (previous_pending_order == null || previous_pending_order.pending_orders == null || previous_pending_order.pending_orders == undefined) {
                        previous_pending_order.pending_orders = [];
                    }
                    else {
                        // Json object is always envelope with key, so we need to remove envelope key
                        previous_pending_order = previous_pending_order.pending_orders;
                    }

                    previous_pending_order.pending_orders.push(current_pending_order);
                    pending_order_data = JSON.stringify(previous_pending_order);

                    client.query('Update users_history set pending_orders=$1 where mobileno=$2',
                        [pending_order_data, mobileno],
                        function (query_err, result) {
                            if (query_err) {
                                console.log('save_pending_orders: Update users_history error running query' + query_err);
                                return;
                            }
                            done();
                        });
                }
                else {
                    console.log("save_pending_orders: Insert query " + JSON.stringify(current_pending_order));
                    previous_pending_order.pendingorders = [];
                    previous_pending_order.pendingorders.push(current_pending_order);
                    client.query('INSERT INTO users_history \
              VALUES ($1, $2, $3,$4,$5 )',
                        [mobileno, null, null, pending_order_data, null],
                        function (query_err, result) {
                            if (query_err) {
                                // handleError(client, done, res, 'error running query' + query_err);
                                console.log("save_pending_orders: error running query" + query_err);
                                return;
                            }
                            done();
                        });
                }


            });

        res.send('success');

    });
});

// This handler stores the bill details and reference no in users_history table
router.post('/save_orders_history', function (req, res, next) {
    console.log("save_orders_history: " + JSON.stringify(req.body));
    var order_details = req.body.order_details;
    var sides = req.body.sides;
    var counter_code = req.body.counter_code;
    var payment_mode = req.body.payment_mode;
    var outlet_id = req.body.outlet_id;
    var order_barcodes = req.body.order_barcodes;
    var mobileno = req.body.mobileno;
    var credit_card_no = req.body.credit_card_no;
    var cardholder_name = req.body.cardholder_name;
    var bill_no = req.body.bill_no;
    var food_details = req.body.food_details;
    var status = req.body.status;
    var ordernumber = req.body.ordernumber;
    var order_histoty_data;
    var outlet_name = req.body.outlet_name;
    var outlet_latitude = req.body.outlet_latitude;
    var outlet_longitude = req.body.outlet_longitude;


    var previous_order_histoty = {};

    var current_order_histoty = {
        "order_details": order_details,
        "sides": sides,
        "counter_code": counter_code,
        "payment_mode": payment_mode,
        "outlet_id": outlet_id,
        "order_barcodes": order_barcodes,
        "mobileno": mobileno,
        "credit_card_no": credit_card_no,
        "cardholder_name": cardholder_name,
        "bill_no": bill_no,
        "food_details": food_details,
        "status": status,
        "outlet_name": outlet_name,
        "date_of_order": general.GetFormattedDateDDMMYYYYHHMMSS(),
        "ordernumber": ordernumber,
        "outlet_latitude": outlet_latitude,
        "outlet_longitude": outlet_longitude
    };

    console.log("current_order_histoty: " + JSON.stringify(current_order_histoty));
    // conString = "postgres://atchayam:foodbox123@192.168.0.87:5432/foodboxdev_old";
    // console.log("conString: " + conString);
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            console.log(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('select order_history from users_history \
      where mobileno = $1',
            [mobileno],
            function (query_err, result_orderdetails) {
                if (query_err) {
                    handleError(client, done, res, '/save_orders_history :: error running query' + query_err);
                    return;
                }
                done();


                var rowslength = result_orderdetails.rows.length;

                // Insert or update users_history
                if (rowslength > 0) {
                    previous_order_histoty = result_orderdetails.rows[0];
                    if (previous_order_histoty == null || previous_order_histoty.order_history == null || previous_order_histoty.order_history == undefined) {
                        previous_order_histoty.order_history = [];
                    }
                    else {
                        // Json object is always envelope with key, so we need to remove envelope key
                        previous_order_histoty = previous_order_histoty.order_history;
                    }

                    previous_order_histoty.order_history.push(current_order_histoty);
                    order_histoty_data = JSON.stringify(previous_order_histoty);

                    client.query('Update users_history set order_history=$1 where mobileno=$2',
                        [order_histoty_data, mobileno],
                        function (query_err, result) {
                            if (query_err) {
                                handleError(client, done, res, '/save_orders_history :: error running query' + query_err);
                                return;
                            }
                            done();
                        });
                }
                else {
                    previous_order_histoty.orderdetails = [];
                    previous_order_histoty.orderdetails.push(current_order_histoty);

                    client.query('INSERT INTO users_history \
              VALUES ($1, $2, $3,$4,$5 )',
                        [mobileno, null, order_histoty_data, null, null],
                        function (query_err, result) {
                            if (query_err) {
                                handleError(client, done, res, '/save_orders_history :: error running query' + query_err);
                                return;
                            }
                            done();
                        });
                }


            });
    });
    //});
    //});

    res.send('success');
});


router.post('/update_orders_history', function (req, res, next) {
    console.log("update_orders_history: " + JSON.stringify(req.body));

    var outlet_id = req.body.outlet_id;
    var mobileno = req.body.mobileno;
    var bill_no = req.body.bill_no;
    var status = "dispensing";
    var previous_order_histoty;
    var order_histoty_data;
    var outlet_name = '';

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            console.log('update_orders_history: Connection error fetching client from pool' + err);
            return;
        }
        client.query('select order_history from users_history \
      where mobileno = $1',
            [mobileno],
            function (query_err, result_orderdetails) {
                if (query_err) {
                    handleError(client, done, res, '/update_orders_history :: error running query' + query_err);
                    console.log('update_orders_history: select order_history error running query' + query_err);
                    return;
                }
                done();


                var rowslength = result_orderdetails.rows.length;

                // Insert or update users_history
                if (rowslength > 0) {
                    previous_order_histoty = result_orderdetails.rows[0];

                    var currentdate = moment().format("YYYY-MM-DD");
                    // previous_order_histoty.order_history.order_history[i].order_barcodes[0].substring(20, 12)
                    if (previous_order_histoty.order_history != null) {
                        for (var i = 0; i < previous_order_histoty.order_history.order_history.length; i++) {
                            var order_date_split = previous_order_histoty.order_history.order_history[i].date_of_order.split('-');
                            var order_date = new Date(order_date_split[2] + "-" + order_date_split[1] + "-" + order_date_split[0]);

                            if (new Date(order_date) >= new Date(currentdate) && previous_order_histoty.order_history.order_history[i].bill_no == bill_no && previous_order_histoty.order_history.order_history[i].status.toLowerCase() == "pending") {
                                console.log("update_orders_history: Bill No: " + previous_order_histoty.order_history.order_history[i].bill_no);
                                previous_order_histoty.order_history.order_history[i].status = status;
                                break;
                            }
                        }

                        client.query('Update users_history set order_history=$1 where mobileno=$2',
                            [previous_order_histoty.order_history, mobileno],
                            function (query_err, result) {
                                if (query_err) {
                                    handleError(client, done, res, 'error running query 3' + query_err);
                                    console.log("update_orders_history: update users_history error running query" + query_err);
                                    return;
                                }

                                done();

                            });
                    }
                }
                else {
                    previous_order_histoty.orderdetails = [];
                    previous_order_histoty.orderdetails.push(current_order_histoty);

                    client.query('INSERT INTO users_history \
              VALUES ($1, $2, $3,$4,$5 )',
                        [mobileno, null, order_histoty_data, null, null],
                        function (query_err, result) {
                            if (query_err) {
                                handleError(client, done, res, 'error running query 4 ' + query_err);
                                console.log("update_orders_history: Insert users_history error running query" + query_err);
                                return;
                            }
                            done();
                        });
                }

                res.send("success");
            });
    });
});


router.get('/get_po_details/:po_id', function (req, res) {
    console.log("api.js :: getpodetails: " + JSON.stringify(req.params));
    try {
        var po_id = req.params.po_id;

        pg.connect(conString, function (err, client, done) {
            try {
                if (err) {
                    general.genericError('error fetching client from pool' + err);
                    res.send("error");
                    return;
                }

                //var query_po_details = "select po.id,po.restaurant_id,po.scheduled_delivery_time,po.scheduled_delivery_time::time as po_time \
                //                        ,poi.food_item_id,poi.quantity,fi.item_tag,fi.name as item_name, r.name as restaurant_name \
                //                         from purchase_order po join purchase_order_master_list poi on po.id = poi.purchase_order_id \
                //                         join food_item fi on poi.food_item_id = fi.id \
                //                         join restaurant r on r.id = fi.restaurant_id \
                //                         where po.id = $1";


                var query_po_details = "select po.id,po.restaurant_id,po.scheduled_delivery_time,po.scheduled_delivery_time::time as po_time,poi.food_item_id \
                                       ,poi.quantity,fi.item_tag,fi.name as item_name, r.name as restaurant_name,fi.master_id , m.start_time,m.end_time, rc.firebase_url  \
                                        ,(SELECT  string_agg(barcode,',') AS barcode \
                                        FROM  purchase_order_batch where purchase_order_id=po.id and base36_decode(substring(barcode,9,4))=fi.id) barcodes \
                                        from purchase_order po join purchase_order_master_list poi on po.id = poi.purchase_order_id \
                                        join food_item fi on poi.food_item_id = fi.id  \
                                        join restaurant r on r.id = fi.restaurant_id \
                                        inner join menu_bands m on m.outlet_id =po.outlet_id \
                                        join restaurant_config rc on rc.restaurant_id = r.id \
                                        where po.id = $1 \
                                        and po.scheduled_delivery_time::time>=m.start_time \
                                        and po.scheduled_delivery_time::time<= m.end_time";

                // and (po.scheduled_delivery_time::time+interval '3 hour')>=m.start_time \
                // and po.scheduled_delivery_time::time+interval '3 hour'<= m.end_time";

                //var query_po_details = "select po.id,po.restaurant_id,po.scheduled_delivery_time,po.scheduled_delivery_time::time as po_time,poi.food_item_id \
                //                       ,poi.quantity,fi.item_tag,fi.name as item_name, r.name as restaurant_name,fi.master_id \
                //                        ,(SELECT  string_agg(barcode,',') AS barcode \
                //                        FROM  purchase_order_batch where purchase_order_id=po.id and base36_decode(substring(barcode,9,4))=fi.id) barcodes \
                //                        from purchase_order po join purchase_order_master_list poi on po.id = poi.purchase_order_id \
                //                        join food_item fi on poi.food_item_id = fi.id  \
                //                        join restaurant r on r.id = fi.restaurant_id \
                //                        where po.id = $1";


                console.log("query_po_details: " + query_po_details + " PO Id: " + po_id);
                client.query(query_po_details, [po_id], function (query_err, result_po_details) {
                    try {
                        if (query_err) {
                            general.genericError('error running query: /po_details: ' + query_err);
                            res.send("error");
                            return;
                        }

                        // releasing the connection
                        done();
                        res.send({ "po_details": result_po_details.rows });
                        return;
                    }
                    catch (e) {
                        general.genericError("outlet.js :: po_details: " + e);
                        res.send("error");
                        return;
                    }
                });
            }
            catch (e) {
                general.genericError("outlet.js :: po_details: " + e);
                res.send("error");
                return;
            }
        });
    }
    catch (e) {
        general.genericError("outlet.js :: po_details: " + e);
        res.send("ERROR");
        return;
    }
});


router.get('/get_menu_bands/:po_id', function (req, res) {
    console.log("api.js :: get_menu_bands: " + JSON.stringify(req.params));
    try {
        var po_id = req.params.po_id;

        pg.connect(conString, function (err, client, done) {
            try {
                if (err) {
                    general.genericError('error fetching client from pool' + err);
                    res.send("error");
                    return;
                }

                var query_po_details = "select start_time, end_time,name from menu_bands mb where mb.outlet_id = $1";

                console.log("query_get_menu_bands: " + query_po_details + " PO Id: " + po_id);
                client.query(query_po_details, [po_id], function (query_err, result_get_menu_bands) {
                    try {
                        if (query_err) {
                            general.genericError('error running query: /get_menu_bands: ' + query_err);
                            res.send("error");
                            return;
                        }

                        // releasing the connection
                        done();
                        res.send({ "get_menu_bands": result_get_menu_bands.rows });
                        return;
                    }
                    catch (e) {
                        general.genericError("outlet.js :: get_menu_bands: " + e);
                        res.send("error");
                        return;
                    }
                });
            }
            catch (e) {
                general.genericError("outlet.js :: get_menu_bands: " + e);
                res.send("error");
                return;
            }
        });
    }
    catch (e) {
        general.genericError("outlet.js :: get_menu_bands: " + e);
        res.send("ERROR");
        return;
    }
});

router.post('/save_reconcile_data', function (req, res, next) {
    console.log("outlet.js :: save_reconcile_data: " + JSON.stringify(req.body));

    var request_data = req.body.reconcile_items;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }

        console.log("outlet.js :: request_data.reconcile_items: " + request_data.reconcile_items);
        for (var item = 0; item < request_data.length; item++) {
            var po_id = request_data[item].po_id;
            var restaurant_id = request_data[item].restaurant_id;
            var restaurant_name = request_data[item].restaurant_name;
            var food_item_id = request_data[item].food_item_id;
            var po_qty = request_data[item].po_qty;
            var scanned_qty = request_data[item].scanned_qty;
            var unscanned_qty = request_data[item].unscanned_qty;
            var damaged_qty = request_data[item].damaged_qty;
            // var damaged_scan_qty = request_data[item].damaged_scan_qty;
            var expiry_qty = request_data[item].expiry_qty;
            var rest_fault_qty = request_data[item].rest_fault_qty;
            // var rest_scan_fault_ctrl = request_data[item].rest_scan_fault_ctrl;
            var remarks = request_data[item].remarks;

            console.log("outlet.js :: po_id: " + po_id);
            if (scanned_qty > 0) {
                // Save scanned data in database
                client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date)VALUES($1,$2,$3,\'scanned\',now());',
                    [po_id, food_item_id, scanned_qty],
                    function (query_err, result) {
                        if (query_err) {
                            handleError(client, done, res, 'error running query Save scanned data::' + query_err);
                            return;
                        }
                        done();
                    });
            }

            if (unscanned_qty > 0) {
                // Save unscanned data in database
                client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date)VALUES($1,$2,$3,\'unscanned\',now());',
                    [po_id, food_item_id, unscanned_qty],
                    function (query_err, result) {
                        if (query_err) {
                            handleError(client, done, res, 'error running query :: Save unscanned data :' + query_err);
                            return;
                        }
                        done();
                    });
            }

            if (damaged_qty > 0) {
                // Save damaged data in database
                client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date)VALUES($1,$2,$3,\'damaged\',now());',
                    [po_id, food_item_id, damaged_qty],
                    function (query_err, result) {
                        if (query_err) {
                            handleError(client, done, res, 'error running query :: Save damaged data :' + query_err);
                            return;
                        }
                        done();
                    });
            }

            if (expiry_qty > 0) {
                // Save unscanned data in database
                client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date)VALUES($1,$2,$3,\'expiry\',now());',
                    [po_id, food_item_id, expiry_qty],
                    function (query_err, result) {
                        if (query_err) {
                            handleError(client, done, res, 'error running query :: Save unscanned data :' + query_err);
                            return;
                        }
                        done();
                    });
            }

            if (rest_fault_qty > 0) {
                // Save unscanned data in database
                client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date,remarks)VALUES($1,$2,$3,\'restaurantfault\',now(),$4);',
                    [po_id, food_item_id, rest_fault_qty, remarks],
                    function (query_err, result) {
                        if (query_err) {
                            handleError(client, done, res, 'error running query :: Save unscanned data :' + query_err);
                            return;
                        }
                        done();
                    });
            }

            //if (rest_scan_fault_ctrl > 0) {
            //    // Save unscanned data in database
            //    client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date,remarks)VALUES($1,$2,$3,\'restaurantscanfault\',now(),$4);',
            //[po_id, food_item_id, rest_scan_fault_ctrl, remarks],
            //function (query_err, result) {
            //    if (query_err) {
            //        handleError(client, done, res, 'error running query :: Save rest_scan_fault data :' + query_err);
            //        return;
            //    }
            //    done();
            //});
            //}

            //if (damaged_scan_qty > 0) {
            //    // Save unscanned data in database
            //    client.query('INSERT INTO purchase_order_reconcile(po_id, item_id, quantity, status,reconcile_date)VALUES($1,$2,$3,\'damaged_scan_qty\',now());',
            //[po_id, food_item_id, damaged_scan_qty],
            //function (query_err, result) {
            //    if (query_err) {
            //        handleError(client, done, res, 'error running query :: Save damaged_scan_qty data :' + query_err);
            //        return;
            //    }
            //    done();
            //});
            //}
        }

        res.send('success');
    });
});

router.get('/check_reconcile_data/:outlet_id', function (req, res) {
    console.log("outlet.js :: check_reconcile_data: " + JSON.stringify(req.params));
    var outlet_id = req.params.outlet_id;
    var sod_datetime = new Date();


    pg.connect(conString, function (err, client, done) {

        var query_outlet_register = "select  COALESCE(max(action_time),now()) as max from outlet_register where outlet_id =$1 and phase='sod'";

        client.query(query_outlet_register, [outlet_id], function (query_err, result_sod) {
            if (query_err) {
                general.genericError('error running query_outlet_register query: /check_reconcile_data: ' + query_err);
                res.send("error");
                return;
            }

            // releasing the connection
            done();

            if (result_sod.rows.length > 0) {
                console.log("outlet.js #################################################### :: query_outlet_register check_reconcile_data: " + result_sod.rows[0].max);

                sod_datetime = result_sod.rows[0].max;
            }

            console.log("sod_datetime #################################################### : " + JSON.stringify(sod_datetime));
            var sod_format_date = moment(sod_datetime).format('YYYY-MM-DD');
            var sod_format_new_date = moment(sod_datetime).add(1, 'days').format('YYYY-MM-DD');

            var query_reconcile_data = "select * from purchase_order where outlet_id = $1 \
                                         and scheduled_delivery_time::date >= '" + sod_format_date + "' and scheduled_delivery_time::date < '" + sod_format_new_date + "' and received_time is null";

            console.log("query_reconcile_data #################################################### : " + query_reconcile_data);

            client.query(query_reconcile_data, [outlet_id], function (query_err, result_reconcile_data) {
                try {
                    if (query_err) {
                        general.genericError('error running query: /check_reconcile_data: ' + query_err);
                        res.send("error");
                        return;
                    }

                    // releasing the connection
                    done();
                    console.log("outlet.js :: check_reconcile_data: " + result_reconcile_data.rows);
                    res.send({ "result_reconcile_data": result_reconcile_data.rows });
                    return;
                }
                catch (e) {
                    general.genericError("api.js :: check_reconcile_data: " + e);
                    res.send("error");
                    return;
                }
            });
        });
    });
});

router.get('/get_eod_status/:id', function (req, res, next) {
    var outlet_id = req.params.id;
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'get_eod_status error fetching client from pool' + err);
            return;
        }

        //client.query("select * from outlet_register otr \
        //                inner join outlet o on o.id = otr.outlet_id \
        //                where otr.outlet_id = $1 and otr.phase='eod' \
        //                and otr.action_time::date= case when to_char(end_of_day, 'HH24:MI')::time - to_char(start_of_day,'HH24:MI')::time < '02:00' then current_date +1  else current_date end \
        //                order by action_time desc limit 1",

        client.query("select * from outlet_register where outlet_id = $1 and phase='eod' and action_time::date=current_date \
                   order by action_time desc limit 1",
            [outlet_id],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, '/get_eod_status/:id :: error running query' + query_err);
                    return;
                }

                // releasing the connection
                done();
                res.send(result);
            });
    });
});

router.post('/Check_Missing_Bills', function (req, res, next) {

    if (req.body.bills != undefined) {
        //var bills = JSON.parse(req.body.bills);
        if (req.body.bills.length > 0) {
            console.log("outlet.js :: Check_Missing_Bills: Reached = " + req.body.bills.length);
            var out = JSON.parse(req.body.bills[0])
            redisClient.del(out.outlet_id);
            for (var i = 0; i < req.body.bills.length; i++) {
                var obj = JSON.parse(req.body.bills[i]);
                redisClient.lpush(obj.outlet_id, req.body.bills[i])
            }
            res.status(200).send("success");
        }
        else {
            res.status(200).send("No Bills to Process");
        }
    }
    else {
        console.log("Check_Missing_Bills :Bill Undefined")
        res.status(500).send("Error");
    }
});

function UpdateOrderHistoryStatus(outlet_id, mobileno, bill_no, status) {
    console.log("UpdateOrderHistory");
    var response_message = "";
    var previous_order_histoty;
    var order_histoty_data;
    var outlet_name = '';
    var pending_status_count = 0;

    pg.connect(conString, function (err, client, done) {
        if (err) {
            console.log('UpdateOrderHistoryStatus: Connection error fetching client from pool' + err);
            debug('UpdateOrderHistoryStatus: Connection error fetching client from pool' + err);
            return;
        }

        client.query('select order_history from users_history \
      where mobileno = $1',
            [mobileno],
            function (query_err, result_orderdetails) {
                if (query_err) {
                    console.log('UpdateOrderHistoryStatus: select order_history error running query' + query_err);
                    debug('UpdateOrderHistoryStatus: select order_history error running query' + query_err);
                    return;
                }
                done();


                var rowslength = result_orderdetails.rows.length;

                // Insert or update users_history
                if (rowslength > 0) {
                    previous_order_histoty = result_orderdetails.rows[0];
                    var currentdate = moment().format("YYYY-MM-DD");

                    if (previous_order_histoty.order_history != null) {
                        for (var i = 0; i < previous_order_histoty.order_history.order_history.length; i++) {
                            var order_date_split = previous_order_histoty.order_history.order_history[i].date_of_order.split('-');
                            var order_date = new Date(order_date_split[2] + "-" + order_date_split[1] + "-" + order_date_split[0]);

                            if (new Date(order_date) >= new Date(currentdate) && previous_order_histoty.order_history.order_history[i].bill_no == bill_no && previous_order_histoty.order_history.order_history[i].status.toLowerCase() == "dispensing") {
                                console.log("UpdateOrderHistoryStatus: Bill No: " + previous_order_histoty.order_history.order_history[i].bill_no);
                                debug("UpdateOrderHistoryStatus: Bill No: " + previous_order_histoty.order_history.order_history[i].bill_no);
                                previous_order_histoty.order_history.order_history[i].status = status;
                                break;
                            }
                        }

                        client.query('Update users_history set order_history=$1 where mobileno=$2',
                            [previous_order_histoty.order_history, mobileno],
                            function (query_err, result) {
                                if (query_err) {
                                    console.log("UpdateOrderHistoryStatus: update users_history error running query" + query_err);
                                    debug("UpdateOrderHistoryStatus: update users_history error running query" + query_err);
                                    return;
                                }

                                done();

                            });
                    }
                }
                else {
                    previous_order_histoty.orderdetails = [];
                    previous_order_histoty.orderdetails.push(current_order_histoty);

                    client.query('INSERT INTO users_history \
              VALUES ($1, $2, $3,$4,$5 )',
                        [mobileno, null, order_histoty_data, null, null],
                        function (query_err, result) {
                            if (query_err) {
                                console.log("UpdateOrderHistoryStatus: Insert users_history error running query" + query_err);
                                debug("UpdateOrderHistoryStatus: Insert users_history error running query" + query_err);
                                return;
                            }
                            done();
                        });
                }

            });
    });
}

// Some utility functions
function updateSalesOrderPayments(order_id, amount, replaced_amount, res) {
    pg.connect(conString, function (err, client, done) {
        if (err) {
            handleError(client, done, res, 'error fetching client from pool' + err);
            return;
        }
        client.query('INSERT INTO sales_order_payments \
      VALUES ($1, $2, $2, \'replaced\', \'modified\'), \
      ($1, $3, $3, \'replaced\', \'modified\')',
            [order_id, -parseInt(amount), parseInt(replaced_amount)],
            function (query_err, result) {
                if (query_err) {
                    handleError(client, done, res, 'error running query 1' + query_err);
                    return;
                }
                done();
            });
    });
}

function updateFinalStatus(res, final_status, barcodes, misc_notes) {
    debugger;
    var barcode_dict = {};
    for (var i = 0; i < barcodes.length; i++) {
        if (barcodes[i] in barcode_dict) {
            barcode_dict[barcodes[i]]++;
        } else {
            barcode_dict[barcodes[i]] = 1;
        }
    }

    async.map(_.keys(barcode_dict),
        function (barcode, map_callback) {
            if (!misc_notes) {
                var problem = '';
                var notes = '';
            } else {
                var problem = misc_notes[barcode]["problem"];
                var notes = misc_notes[barcode]["note"];
            }
            // using a cool CTE, check it out !
            config.query('INSERT INTO purchase_order_final_status \
      (batch_id, purchase_order_id, barcode, food_item_id, quantity, status, problem, note) \
      VALUES ((SELECT id FROM purchase_order_batch WHERE barcode= $1 limit 1 ), \
        (SELECT purchase_order_id FROM purchase_order_batch WHERE barcode=$1 limit 1 ), \
        $1, $2, $3, $4, $5, $6);',
                [barcode, getItemId(barcode), barcode_dict[barcode], final_status,
                    problem, notes],
                function (query_err, result) {
                    if (query_err) {
                        map_callback(query_err, null);
                        return;
                    }
                    map_callback(null, true);
                    return;
                });
        },
        function (map_err, result) {
            if (map_err) {
                handleErrorNew();
                console.error(map_err);
                return;
            }
            res.send('success');
            return;
        });
}

var handleError = function (client, done, res, msg) {
    done(client);
    console.error(msg);
    res.status(500).send(msg);
};

var handleErrorNew = function (err, res) {
    console.error(err);
};

var sanitizeInteger = function (str) {
    if (!str) {
        return null;
    }
    return str;
};

function getItemId(barcode) {
    return parseInt(barcode.substr(8, 4), 36);
}

function parseTime(timeStr, dt) {
    if (!dt) {
        dt = new Date();
    }

    var time = timeStr.match(/(\d+)(?::(\d\d))?\s*(p?)/i);
    if (!time) {
        return NaN;
    }
    var hours = parseInt(time[1], 10);
    if (hours == 12 && !time[3]) {
        hours = 0;
    }
    else {
        hours += (hours < 12 && time[3]) ? 12 : 0;
    }

    dt.setHours(hours);
    dt.setMinutes(parseInt(time[2], 10) || 0);
    dt.setSeconds(0, 0);
    return dt;
}

Date.prototype.yyyymmdd = function () {
    var yyyy = this.getFullYear().toString();
    var mm = (this.getMonth() + 1).toString(); // getMonth() is zero-based
    var dd = this.getDate().toString();
    return yyyy + "-" + (mm[1] ? mm : "0" + mm[0]) + "-" + (dd[1] ? dd : "0" + dd[0]); // padding
};

function delete_mobile_pending_orders(outlet_id) {
    pg.connect(conString, function (err, client, done) {
        try {
            if (err) {
                handleError('delete_mobile_pending_orders:: error fetching client from pool ' + err);
                return;
            }

            var queryText = 'Delete from mobile_pending_orders where outlet_id=$1';

            client.query(queryText, [outlet_id], function (query_err, result) {
                try {
                    if (query_err) {
                        handleError('delete_mobile_pending_orders:: error running query' + query_err);
                        return;
                    }

                    // releasing the connection
                    done();
                    return;
                } catch (e) {
                    general.genericError("outlet.js :: delete_mobile_pending_orders: " + e);
                }
            });
        } catch (e) {
            general.genericError("outlet.js :: delete_mobile_pending_orders: " + e);
        }
    });
}

// Get restaurant email id from restaurant_config table
var getrestaurant_EmailID = function (restaurant_id, callback) {
    dbUtils.getrestaurant_EmailID(restaurant_id, function (err, result) {
        if (err) {
            console.log("getrestaurant_EmailID error" + JSON.stringify(err));
            callback(err, null);
        }
        else {
            console.log("getrestaurant_EmailID Email: " + result)
            callback(null, result);
        }
    });
}

module.exports = router;
