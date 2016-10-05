// Utility code to get the current month
var d = new Date();
var month = new Array();
month[0] = "January";
month[1] = "February";
month[2] = "March";
month[3] = "April";
month[4] = "May";
month[5] = "June";
month[6] = "July";
month[7] = "August";
month[8] = "September";
month[9] = "October";
month[10] = "November";
month[11] = "December";
var n_month = month[d.getMonth()];

$("#notifications").on("click", ".notification", function () {
	var category = $(this).find(".category").text();
	switch (category) {
	case "Cash":
		var key = $(this).attr("id");
		// Getting the order details from simple storage
		var val = simpleStorage.get(key);
		var counter_code = val["counter_code"];
		var order_details = val["order_details"];
		var mode = val["payment_mode"];
		var total_amount = 0;
		// populating the cash collection dialog
		$("#cash-collection-dialog .modal-body table tbody").empty();
		for (var item_id in order_details) {
			total_amount += order_details[item_id]["price"] * order_details[item_id]["count"];
			$("#cash-collection-dialog .modal-body table tbody").append("<tr><td>" + item_id + "</td><td>" + order_details[item_id]["name"] + "</td><td>" + order_details[item_id]["count"] + "</td></tr>");
		}
		$("#cash_collection_confirm").attr("data-key", key);
		$("#cash-collection-dialog .modal-header .counter_code").text(counter_code);
		$("#cash-collection-dialog .modal-header .total_amount").text(total_amount);
		$("#cash-collection-dialog").modal("show");
		break;
	case "Expiry":
		var slots = simpleStorage.get("expiry_slots");
		$("#expiry-items-dialog .modal-body .item_count").text(slots.length);
		$("#expiry-items-dialog .modal-body .slot_ids").text(slots);
		$("#expiry-items-dialog").modal("show");
		break;
	default:
		break;
	}
});

$("#collect_cash").on("click", ".cash_notification .done", function () {
	//  $(".cash_notification a").attr("disabled", "disabled");
	// Disabling the button
	$(this).css("pointer-events", "none");
	// Removing the cash change dialog
	$(this).parent().next().remove();
	// Send the data to LC to print bill and dispense item
	var key = $(this).attr("id");
	var val = simpleStorage.get(key);
	console.log("simpleStorage===--------------------:- ", JSON.stringify(val));
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/order_app/place_order',
		timeout : 5000,
		data : JSON.stringify({
			"order" : val["order_details"],
			"sides" : val["sides"],
			"bill_no" : val["bill_no"],
			"counter_code" : val["counter_code"],
			"mode" : val["payment_mode"],
			"from_counter" : true,
			"savings" : val["savings"],
			"mobile_num" : val["mobile_num"],
			"credit_card_no" : val["credit_card_no"],
			"cardholder_name" : val["cardholder_name"],
			"test_mode" : false,
			"unique_Random_Id" : val["unique_Random_Id"]
		}),
		success : function (data) {
			console.log(data);
			// Deleting the data from local storage
			simpleStorage.deleteKey(key);
			// Deleting the element from the page
			$("#" + key).parent().remove()
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			$(this).css("pointer-events", "auto");
			console.error("Place order failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#collect_cash").on("mouseover", ".cash_notification", function (event) {
	$(this).next().show();
	$(this).next().css("top", $(this).position().top);
	$(this).next().css("left", $(this).position().left + $(this).width());
});

$("#collect_cash").on("mouseout", ".cash_notification", function (event) {
	$(this).next().hide();
});

$("#expiry_items_confirm").click(function () {
	// Call the expiry items removal API
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/signal_expiry_item_removal',
		success : function (data) {
			console.log(data);
			// Remove all the expiry notifications
			$("#notifications .notification").each(function () {
				var category = $(this).find(".category").text();
				if (category == "Expiry") {
					$(this).remove();
					return true;
				}
			});
			// Deleting the key and all its data
			simpleStorage.deleteKey("expiry_slots");
			// Hiding the dialog
			$("#expiry-items-dialog").modal("hide");
			// The flag from_load_items is there otherwise, the unscanned items
			// dialog would have opened if the expiry items dialog was directly opened
			if (from_load_items) {
				// after the unload unscanned items is clicked, an ajax call will get the data from redis
				// this will include the item ids and the batch_id and PO ids
				$.getJSON(OUTLET_URL + '/outlet_app/unscanned_slots')
				.done(function (data) {
					var unscanned_slots_array = data["unscanned_slots"];
					if (unscanned_slots_array != undefined) {
						unscanned_slots_array = prettyPrintSlots(unscanned_slots_array);
						var unscanned_slots = '';
						unscanned_slots_array.map(function (slot) {
							unscanned_slots += "<div class=\"unscanned_slot_item\">" + slot + "</div>";
						});
						$("#unscanned-items-dialog .modal-body .slot_ids").append(unscanned_slots);
					}
					if (from_eod) {
						$("#unscanned-items-dialog .modal-title").text("End of Day");
						$("#unscanned-items-dialog .modal-header img").attr("src", "img/icons/End of Day.png");
					} else {
						$("#unscanned-items-dialog .modal-title").text("Load");
						$("#unscanned-items-dialog .modal-header img").attr("src", "img/icons/Load_black.png");
					}
					$("#unscanned-items-dialog").modal("show");
					from_load_items = false;
				})
				.fail(function (jqxhr, textStatus, error) {
					var err_msg = textStatus + ", " + jqxhr.responseText;
					console.error("Request Failed: " + err_msg);
				});
			}
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Place order failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#unscanned_items_confirm").click(function () {
	// signalling the LC that unscanned items have been removed
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/update_unscanned_items',
		success : function (data) {
			console.log(data);
			// get the item ids for loading issue items and open the dialog
			$.getJSON(OUTLET_URL + '/outlet_app/get_loading_issue_items')
			.done(function (data) {
				if (!Object.keys(data).length) {
					$("#unscanned-items-dialog").modal("hide");
					return;
				}
				console.log("unscanned- ", data["unscanned"]);
				console.log("loading- ", data["loading_issue"]);

				last_batch_item_ids = data["loading_issue"];
				var targetDiv = $("#loading-issue-dialog .modal-body .loading_issue_item_id_list table tbody");
				$(targetDiv).empty();
				// constructing the issue dropdown
				var issuedropDown = '<select class="problem">';
				ISSUE_TYPES.map(function (item) {
					issuedropDown += '<option>' + item + '</option>';
				});
				issuedropDown += '</select>';
				var fooditemdropDown = '<select class="food_item">';
				for (var i = 0; i < last_batch_item_ids.length; i++) {
					fooditemdropDown += '<option data-po_id="' + last_batch_item_ids[i]["purchase_order_id"] + '" data-batch_id="' + last_batch_item_ids[i]["batch_id"] + '" data-barcode="' + last_batch_item_ids[i]["barcode"] + '">' + last_batch_item_ids[i]["short_name"] + '-' + last_batch_item_ids[i]["item_id"] + '-' + last_batch_item_ids[i]["name"] + '</option>';
				}
				$(targetDiv).append('<tr class="item"><td>' + fooditemdropDown + '</td><td><input class="qty" type="text" /></td><td>' + issuedropDown + '</td><td><input class="note" type="text" /><img class="trash" src="img/icons/Trash.png" height="20"></td></tr>');

				last_batch_item_ids = data["unscanned"];
				var targetDiv = $("#loading-issue-dialog .modal-body .unscanned_item_id_list table tbody");
				$(targetDiv).empty();
				// constructing the issue dropdown
				var issuedropDown = '<select class="problem">';
				issuedropDown += '<option>unable to scan (Rest. fault)</option>';
				issuedropDown += '<option>scanner fault (Foodbox fault)</option>';
				issuedropDown += '</select>';
				fooditemdropDown = '<select class="food_item">';
				for (var i = 0; i < last_batch_item_ids.length; i++) {
					fooditemdropDown += '<option data-po_id="' + last_batch_item_ids[i]["purchase_order_id"] + '" data-batch_id="' + last_batch_item_ids[i]["batch_id"] + '" data-barcode="' + last_batch_item_ids[i]["barcode"] + '">' + last_batch_item_ids[i]["short_name"] + '-' + last_batch_item_ids[i]["item_id"] + '-' + last_batch_item_ids[i]["name"] + '</option>';
				}
				$(targetDiv).append('<tr class="item"><td>' + fooditemdropDown + '</td><td><input class="qty" type="text" /></td><td>' + issuedropDown + '</td><td><input class="note" type="text" /><img class="trash" src="img/icons/Trash.png" height="20"></td></tr>');

				// then close the dialog
				$("#unscanned-items-dialog").modal("hide");
				if (from_eod) {
					$("#loading-issue-dialog .modal-title").text("End of Day");
					$("#loading-issue-dialog .modal-header img").attr("src", "img/icons/End of Day.png");
					// Removing the loading issue area because this is during end of day
					$("#loading-issue-dialog .modal-body .loading_issue_item_id_list").empty();
					$("#loading-issue-dialog .modal-body .loading_add_btn").remove();
				} else {
					$("#loading-issue-dialog .modal-title").text("Load");
					$("#loading-issue-dialog .modal-header img").attr("src", "img/icons/Load_black.png");
				}
				$("#loading-issue-dialog").modal("show");
			})
			.fail(function (jqxhr, textStatus, error) {
				var err_msg = textStatus + ", " + jqxhr.responseText;
				console.error("Request Failed: " + err_msg);
			});
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Update unscanned items failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#loading-issue-dialog .modal-body .loading_add_btn").click(function () {
	// cloning the row and then appending it to the table
	var clonedRow = $("#loading-issue-dialog .modal-body .loading_issue_item_id_list table tbody tr").last().clone();
	// Resetting text boxes to null
	$(clonedRow).find('input[type=text]').val("");
	var targetDiv = $("#loading-issue-dialog .modal-body .loading_issue_item_id_list table tbody");
	$(targetDiv).append(clonedRow);
});

$("#loading-issue-dialog .modal-body .unscanned_add_btn").click(function () {
	// cloning the row and then appending it to the table
	var clonedRow = $("#loading-issue-dialog .modal-body .unscanned_item_id_list table tbody tr").last().clone();
	// Resetting text boxes to null
	$(clonedRow).find('input[type=text]').val("");
	var targetDiv = $("#loading-issue-dialog .modal-body .unscanned_item_id_list table tbody");
	$(targetDiv).append(clonedRow);
});

$("#loading-issue-dialog .modal-body").on("click", ".trash", function () {
	// delete the current row
	$(this).parent().parent().remove();
});

$("#loading_issue_confirm").click(function () {
	// Disabling the button on click
	$("#loading_issue_confirm").prop("disabled", true);
	var item_id_list = [];
	$("#loading-issue-dialog .modal-body .loading_issue_item_id_list table tbody tr").each(function () {
		var purchase_order_id = $(this).find(".food_item :selected").attr("data-po_id");
		var batch_id = $(this).find(".food_item :selected").attr("data-batch_id");
		var barcode = $(this).find(".food_item :selected").attr("data-barcode");
		var qty = $(this).find(".qty").val();
		if (qty == "") {
			return;
		}
		var problem = $(this).find(".problem").val();
		var note = $(this).find(".note").val();
		var item_id = $(this).children().first().children().val().split('-')[1];
		item_id_list.push({
			"batch_id" : batch_id,
			"barcode" : barcode,
			"purchase_order_id" : purchase_order_id,
			"qty" : qty,
			"item_id" : item_id,
			"problem" : problem,
			"note" : note
		});
	});

	$("#loading-issue-dialog .modal-body .unscanned_item_id_list table tbody tr").each(function () {
		var purchase_order_id = $(this).find(".food_item :selected").attr("data-po_id");
		var batch_id = $(this).find(".food_item :selected").attr("data-batch_id");
		var barcode = $(this).find(".food_item :selected").attr("data-barcode");
		var qty = $(this).find(".qty").val();
		if (qty == "") {
			return;
		}
		var problem = $(this).find(".problem").val();
		var note = $(this).find(".note").val();
		var item_id = $(this).children().first().children().val().split('-')[1];
		item_id_list.push({
			"batch_id" : batch_id,
			"barcode" : barcode,
			"purchase_order_id" : purchase_order_id,
			"qty" : qty,
			"item_id" : item_id,
			"problem" : problem,
			"note" : note
		});
	});

	// Now push the item details to LC and from there to HQ
	// take the item id dict here. Basically the count of itemids
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/store_loading_issue_items',
		data : JSON.stringify({
			"item_id_info" : item_id_list
		}),
		success : function (data) {
			console.log(data);
			$("#loading_issue_confirm").prop("disabled", false);
			$("#loading-issue-dialog").modal("hide");
			if (from_eod) {
				from_eod = false;
				location.reload(true);
			}
		},
		error : function (jqxhr, textStatus, error) {
			$("#loading_issue_confirm").prop("disabled", false);
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Store loading issue items failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#purchase_orders .incoming_pos").click(function () {
	$("#incoming-po-dialog").modal("show");
});

$("#incoming-po-dialog .modal-footer .incoming_po_select").click(function () {
	// get the radio button item
	// get the rest_id, po and batch id
	var po_id = $("#incoming-po-dialog .modal-body input[type=radio]:checked").val();
	var batch_id = $("#incoming-po-dialog .modal-body input[type=radio]:checked").parents("tr").first().attr("data-batch_id");
	var rest_id = $("#incoming-po-dialog .modal-body input[type=radio]:checked").parents("tr").first().attr("data-rest_id");
	// and delete the row
	$("#incoming-po-dialog .modal-body input[type=radio]:checked").parents("tr").first().remove();

	// Add the removed combo to simpleStorage
	var existing = simpleStorage.get("incoming_po_tracker");
	if (!existing) {
		existing = [];
	}
	existing.push({
		po_id : po_id,
		batch_id : batch_id,
		rest_id : rest_id
	});
	simpleStorage.set("incoming_po_tracker", existing);

	// If no PO is selected, then directly return
	if (po_id == undefined) {
		$("#incoming-po-dialog").modal("hide");
		return;
	}

	// and store it in LC.
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/store_last_load_info',
		data : JSON.stringify({
			"po_id" : po_id,
			"batch_id" : batch_id,
			"rest_id" : rest_id
		}),
		success : function (data) {
			console.log(data);
			// and decrease the counter
			$("#purchase_orders .incoming_pos .num").text(parseInt($("#purchase_orders .incoming_pos .num").text()) - 1);
			console.log($("#purchase_orders .incoming_pos .num").text());
			// and then close the dialog
			$("#incoming-po-dialog").modal("hide");
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Place order failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#eod_confirm").click(function () {
	// gather the data from the form and post it
	// on return, hide the dialog and reload the page
	var eod_supplies = {};
	$("#eod-dialog .modal-body table tbody tr").each(function () {
		var item_id = $(this).attr("data-item_id");
		var count = $.trim($(this).find("input[type=text]").val());
		count = count === "" ? 0 : count;
		eod_supplies[item_id] = count;
	});

	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/end_of_day_signal',
		data : JSON.stringify({
			"supplies" : eod_supplies
		}),
		success : function (data) {
			console.log(data);
			// Hiding the dialog
			$("#eod-dialog").modal("hide");
			from_eod = true;
			// going into the load items workflow. i.e. the 3 screens.
			$("#load_items").trigger("click");
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Place order failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});

	// Triggering the stopping of orders
	$("#orders .panel_header .stop_order").trigger("click");
});

$("#sod_confirm").click(function () {
	// gather the data from the form and post it
	// on return hide the dialog
	var sod_supplies = {};
	$("#sod-dialog .modal-body table tbody tr").each(function () {
		var item_id = $(this).attr("data-item_id");
		var count = $.trim($(this).find(".supply_qty").val());
		count = count === "" ? 0 : count;
		sod_supplies[item_id] = count;
	});

	simpleStorage.deleteKey("incoming_po_tracker");

	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/start_of_day_signal',
		data : JSON.stringify({
			"supplies" : sod_supplies
		}),
		success : function (data) {
			console.log(data);
			// Hiding the dialog
			$("#sod-dialog").modal("hide");
			// Showing the test mode dialog
			$("#test_mode-dialog").modal({
				show : true,
				backdrop : "static"
			});
			simpleStorage.set("test_mode", true);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Start of day signal failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});

	// Enabling orders from the order tab
	// Also checking if it has been stopped before, do it only then
	if ($("#orders .panel_header .stop_order").text() == "Start") {
		$("#orders .panel_header .stop_order").trigger("click");
	}
});

$("#test_mode-dialog .modal-footer #test_complete").click(function () {
	// Hiding the dialog
	$("#test_mode-dialog").modal("hide");
	simpleStorage.set("test_mode", false);
	// Stopping the test mode
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/test_mode',
		data : JSON.stringify({
			"flag" : false
		}),
		success : function (data) {
			console.log(data);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Stopping test mode failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
	// Reloading the page, to prevent start_of_day to appear again
	location.reload(true);
});

$("#test_mode-dialog .modal-body #start_stage_1").click(function () {
	// Update modal DOM
	$("#test_mode-dialog .modal-body").attr("data-test-stage", "Stage 1");
	$("#test_mode-dialog .modal-body .test_stage").text("Test is at stage - 1");
	// Send the signal to LC
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/test_mode',
		data : JSON.stringify({
			"flag" : true
		}),
		success : function (data) {
			console.log(data);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Starting test mode failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#test_mode-dialog .modal-body #start_stage_2").click(function () {
	// Update modal DOM
	$("#test_mode-dialog .modal-body").attr("data-test-stage", "Stage 2");
	$("#test_mode-dialog .modal-body .test_stage").text("Test is at stage - 2");
});

$("#test_mode-dialog .modal-body .report_issue button").click(function () {
	var issue_text = $("#test_mode-dialog .modal-body textarea").val();
	$("#test_mode-dialog .modal-body textarea").val("");
	if (!issue_text) {
		return false;
	}
	var stage = $("#test_mode-dialog .modal-body").attr("data-test-stage");
	issue_text = stage + " - " + issue_text;
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/test_mode_issue',
		data : JSON.stringify({
			"text" : issue_text
		}),
		success : function (data) {
			console.log(data);
			$("#test_mode-dialog .modal-body .report_issue").append('<div>' + data + '</div>');
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Reporting of test_issue failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#sales_cash .panel_header .spends").click(function () {
	// Resetting all the previous values to null
	$("#petty_cash-dialog .modal-body .amount").val("");
	$("#petty_cash-dialog .modal-body .note").val("");
	$("#petty_cash-dialog .modal-body .success_notification").remove();
	// Get the petty cash table
	$.getJSON(OUTLET_URL + '/outlet_app/petty_cash_breakdown')
	.done(function (data) {
		var targetDiv = $("#petty_cash-dialog .modal-body table tbody");
		$(targetDiv).empty();
		var totalAmount = 0;
		for (var i = 0; i < data.length; i++) {
			var amount = data[i]["amount"];
			var note = data[i]["note"];
			var date_obj = new Date(data[i]["time"]);
			$(targetDiv).append('<tr><td><img class="icons" src="img/icons/Rupee.png">' + amount + '</td><td>' + note + '</td><td>' + getCustomDate(date_obj) + '</td></tr>');
			totalAmount += amount;
		}
		// Update the total amount
		$("#petty_cash-dialog .modal-body .total_expenditure").text(totalAmount);
		// Show the dialog
		$("#petty_cash-dialog").modal("show");
	})
	.fail(function (jqxhr, textStatus, error) {
		var err_msg = textStatus + ", " + jqxhr.responseText;
		console.error("Request Failed: " + err_msg);
	});
});

$("#petty_cash-dialog .modal-footer .submit_petty_cash").click(function () {
	var amount = parseInt($("#petty_cash-dialog .modal-body .amount").val());
	var note = $("#petty_cash-dialog .modal-body .note").val();
	if (isNaN(parseInt($("#petty_cash-dialog .modal-body .amount").val()))) {
		$("#petty_cash-dialog").modal("hide");
		return;
	}
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/petty_expenditure',
		data : JSON.stringify({
			"data" : {
				"amount" : amount,
				"note" : note
			}
		}),
		success : function (data) {
			console.log(data);
			$("#petty_cash-dialog .modal-body .enter_petty_cash").append('<div class="success_notification">' + data + '</div>');
			$("#petty_cash-dialog").modal("hide");
			getSalesData();
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Reporting of petty cash failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#load_items").click(function () {
	var slots = simpleStorage.get("expiry_slots");
	if (from_eod) {
		$("#expiry-items-dialog .modal-title").text("End of Day");
		$("#expiry-items-dialog .modal-header img").attr("src", "img/icons/End of Day.png");
	} else {
		$("#expiry-items-dialog .modal-title").text("Load");
		$("#expiry-items-dialog .modal-header img").attr("src", "img/icons/Load_black.png");
	}
	if (slots) {
		slots = slots.map(Number).sort(function (a, b) {
				return a - b
			});
		// Making the slots unique
		var uniqueSlots = [];
		$.each(slots, function (i, el) {
			if ($.inArray(el, uniqueSlots) === -1)
				uniqueSlots.push(el);
		});
		$("#expiry-items-dialog .modal-body .item_count").text(uniqueSlots.length);
		$("#expiry-items-dialog .modal-body .slot_ids").text(uniqueSlots);
	} else {
		$("#expiry-items-dialog .modal-body .item_count").text('0');
		$("#expiry-items-dialog .modal-body .slot_ids").text('None');
	}
	from_load_items = true;
	$("#expiry-items-dialog").modal("show");
});

$("#message_center .num_threads").click(function () {
	$("#message-threads-dialog").modal("show");
});

$("#message-comments-dialog .modal-header .back_to_threads").click(function () {
	$("#message-comments-dialog").modal("hide");
	$("#message-threads-dialog").modal("show");
});

$("#issues .panel_header .report_issues").click(function () {
	$.getJSON(OUTLET_URL + '/outlet_app/food_item_list')
	.done(function (data) {
		var food_item_list = data["food_item_list"];
		data["non_food_types"] = data["non_food_types"].replace(/"/g, '');
		var non_food_issue_types = (data["non_food_types"].substr(1, data["non_food_types"].length - 2)).split(',');

		// populating the non-food issues area
		$("#report-issues-dialog .modal-body #non_food_issue textarea").val("");
		targetDiv = $("#report-issues-dialog .modal-body #non_food_issue .category");
		$(targetDiv).empty();
		// creating the categories and subcategories first
		var non_food_categories = {};
		for (var i = 0; i < non_food_issue_types.length; i++) {
			var main_category = non_food_issue_types[i].split(':')[0];
			var sub_category = non_food_issue_types[i].split(':')[1];
			if (non_food_categories.hasOwnProperty(main_category)) {
				non_food_categories[main_category].push(sub_category);
			} else {
				non_food_categories[main_category] = [sub_category];
			}
		}
		// Adding them to the dropdown
		for (var key in non_food_categories) {
			var text = '<optgroup label="' + key + '">';
			for (var i = 0; i < non_food_categories[key].length; i++) {
				text += '<option>' + non_food_categories[key][i] + '</option>';
			}
			text += '</optgroup>';
			$(targetDiv).append(text);
		}
		$("#report-issues-dialog .modal-body #non_food_issue .reporter").empty();
		$("#staff-roster-dialog .togglebutton .username").each(function (item) {
			$("#report-issues-dialog .modal-body #non_food_issue .reporter").append('<option>' + $(this).text() + '</option>');
		});
		// Triggering the food btn click first so that the
		// proper tab is highlighted
		$("#report-issues-dialog").modal("show");
		$.material.init();
	})
	.fail(function (jqxhr, textStatus, error) {
		var err_msg = textStatus + ", " + jqxhr.responseText;
		console.error("Request Failed: " + err_msg);
	});
});

$("#report-issues-dialog .modal-footer .submit_report_issue").click(function () {
	var barcode_details = [];
	var no_barcode = false;

	var non_food_issue = {};
	var non_food_issue_subtype = $("#report-issues-dialog .modal-body #non_food_issue .category").val();
	var non_food_parent_category = $("#report-issues-dialog .modal-body #non_food_issue .category option:selected").parent().attr('label');
	if (non_food_issue_subtype != '') {
		non_food_issue["type"] = non_food_parent_category + ':' + non_food_issue_subtype;
		non_food_issue["note"] = $("#report-issues-dialog .modal-body #non_food_issue textarea").val();
	}
	non_food_issue["reporter"] = $("#report-issues-dialog .modal-body #non_food_issue .reporter").val();
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/update_item_issues',
		data : JSON.stringify({
			"barcode_details" : barcode_details,
			"non_food_issue" : non_food_issue
		}),
		success : function (data) {
			console.log(data);
			// Hiding the dialog
			$("#report-issues-dialog").modal("hide");
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Place order failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
});

$("#report-issues-dialog .modal-body .food_btn").click(function () {
	// Updating the color
	$("#report-issues-dialog .modal-body .food_btn").css("background-color", "#CCCCCC");
	$("#report-issues-dialog .modal-body .non_food_btn").css("background-color", "white");
	$("#report-issues-dialog .modal-body .non_food_btn").css("border", "1px solid #CCCCCC");
	// Hiding/displaying the appropriate div
	$("#report-issues-dialog .modal-body #food_issue").show();
	$("#report-issues-dialog .modal-body #non_food_issue").hide();
});

$("#report-issues-dialog .modal-body .non_food_btn").click(function () {
	// Updating the color
	$("#report-issues-dialog .modal-body .non_food_btn").css("background-color", "#CCCCCC");
	$("#report-issues-dialog .modal-body .food_btn").css("background-color", "white");
	$("#report-issues-dialog .modal-body .food_btn").css("border", "1px solid #CCCCCC");
	// Hiding/displaying the appropriate div
	$("#report-issues-dialog .modal-body #non_food_issue").show();
	$("#report-issues-dialog .modal-body #food_issue").hide();
});

$("#staff_roster").click(function () {
	$("#staff-roster-dialog").modal("show");
});

$("#beverage_control").click(function () {
	$("#beverage-control-dialog").modal("show");
});

$("#force_failure").click(function () {
	$("#force-failure-dialog").modal("show");
});

$("#do_eod").click(function () {
	if (confirm("This will expire all stock! Do you want to proceed?")) {
		showEODDialog();
	}
});

$("#staff-roster-dialog .modal-footer .save_roster").click(function () {
	$("#staff-roster-dialog .modal-body .togglebutton").each(function (index) {
		// get current status
		var new_status = $(this).find('input[type=checkbox]').is(':checked') ? 'shift_start' : 'shift_end';
		var user_id = $(this).find('span.username').attr('data-id');
		// check with original status
		// if different, update the roster for that person
		if (new_status != staff_roster[user_id]) {
			$.ajax({
				type : 'POST',
				url : OUTLET_URL + '/outlet_app/staff_roster',
				data : JSON.stringify({
					"data" : {
						"user_id" : user_id,
						"shift" : new_status
					}
				}),
				success : function (data) {
					console.log(data);
					// in the success callback, call getStaffRoster()
					getStaffRoster();
				},
				error : function (jqxhr, textStatus, error) {
					var err_msg = textStatus + ", " + jqxhr.responseText;
					console.error("Place order failed: " + err_msg);
				},
				contentType : "application/json",
				dataType : 'text'
			});
		}
	});
	$("#staff-roster-dialog").modal("hide");
});

$("#beverage-control-dialog .modal-footer .update_beverages").click(function () {
	$("#beverage-control-dialog .modal-body .togglebutton").each(function (index) {
		// get current status
		var new_status = $(this).find('input[type=checkbox]').is(':checked');
		var item_id = $(this).find('span.beverage_item').attr('data-id');
		// update the new status in the dictionary
		beverage_data[item_id]["visible"] = new_status;
		simpleStorage.set(item_id + "_visibility", new_status);
	});
	// Posting the data to LC
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/beverage_control',
		data : JSON.stringify({
			"data" : beverage_data
		}),
		success : function (data) {
			console.log(data);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Updating beverage control failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
	$("#beverage-control-dialog").modal("hide");
});

$("#force-failure-dialog .modal-footer .mark_failed").click(function () {
	var btn = $(this);
	btn.attr('disabled', 'disabled');
	var fail_all = $('#force-failure-dialog .modal-body .fail-all').prop('checked');
	console.log("Fail All PO: " + fail_all);
	// Posting the data to LC
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/force_fail_entire_stock',
		data : JSON.stringify({
			"fail_all" : fail_all
		}),
		success : function (data) {
			var allItems = [];
			$("#incoming-po-dialog .modal-body tbody tr").each(function () {
				// get the radio button item
				// get the rest_id, po and batch id
				var po_id = $($(this).children()[1]).text();
				var batch_id = $(this).attr("data-batch_id");
				var rest_id = $(this).attr("data-rest_id");
				// and delete the row
				$(this).remove();

				// Add the removed combo to simpleStorage
				var existing = simpleStorage.get("incoming_po_tracker");
				if (!existing) {
					existing = [];
				}
				allItems.push({
					po_id : po_id,
					batch_id : batch_id,
					rest_id : rest_id
				})
				existing.push({
					po_id : po_id,
					batch_id : batch_id,
					rest_id : rest_id
				});
				simpleStorage.set("incoming_po_tracker", existing);

				$("#purchase_orders .incoming_pos .num").text(parseInt($("#purchase_orders .incoming_pos .num").text()) - 1);
				console.log($("#purchase_orders .incoming_pos .num").text());
			});

			// and store it in LC.
			$.ajax({
				type : 'POST',
				url : OUTLET_URL + '/outlet_app/mark_po_received',
				data : JSON.stringify(allItems),
				success : function (data) {
					console.log(data);
				},
				error : function (jqxhr, textStatus, error) {
					var err_msg = textStatus + ", " + jqxhr.responseText;
					console.error("Marking po received failed: " + err_msg);
				},
				contentType : "application/json",
				dataType : 'text'
			});

			console.log(data);
			btn.removeAttr('disabled');
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Manual failure of stocks failed: " + err_msg);
			btn.removeAttr('disabled');
		},
		contentType : "application/json",
		dataType : 'text'
	});
	$("#force-failure-dialog").modal("hide");
});

function checkStartOfDay() {
	// check if outlet is not 24hr and start of day flag is enabled
	if (!is24hr && start_of_day) {
		var tableDiv = $("#sod-dialog .modal-body table tbody");
		$(tableDiv).empty();
		for (var i = 0; i < supply_list.length; i++) {
			$(tableDiv).append('<tr data-item_id="' + supply_list[i].id + '"><td><img src="' + supply_list[i].image_url + '" height="30">' + supply_list[i].name + '</td><td><input type="number" class="supply_qty" max="10000" onKeyUp="if (this.value.length > 5) { this.value = this.value.substring(0, 5);} "/></td></tr>');
		}
		$("#sod-dialog").modal({
			show : true,
			backdrop : "static"
		});
	}
}

$("#orders .panel_header .stop_order").click(function () {
	// get the current text , and send the message to the LC
	var text = $(this).find("span").text();
	// toggle the button text
	if (text == 'Stop') {
		$(this).find("span").text("Start");
		$(this).find("img").attr("src", "img/icons/Delivered.png");
		sendStopOrder();
	} else {
		$(this).find("span").text("Stop");
		$(this).find("img").attr("src", "img/icons/Stop.png");
		sendStartOrder();
	}
	simpleStorage.set("stop_order_status", text);
});

function sendStopOrder() {
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/stop_orders',
		success : function (data) {
			console.log(data);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Send stop orders failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
}

function sendStartOrder() {
	$.ajax({
		type : 'POST',
		url : OUTLET_URL + '/outlet_app/resume_orders',
		success : function (data) {
			console.log(data);
		},
		error : function (jqxhr, textStatus, error) {
			var err_msg = textStatus + ", " + jqxhr.responseText;
			console.error("Send resume orders failed: " + err_msg);
		},
		contentType : "application/json",
		dataType : 'text'
	});
}
