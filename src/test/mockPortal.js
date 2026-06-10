const express = require('express');
const app = express();
const port = 3001;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mock Job Portal</title>
      <style>
        body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="text"], input[type="email"], select, textarea { width: 100%; padding: 8px; }
        .radio-group label { display: inline; font-weight: normal; margin-right: 15px; }
      </style>
    </head>
    <body>
      <h1>Apply for QA Engineer</h1>
      <form id="apply-form" action="/submit" method="POST">
        <!-- Obvious Fields (Should be caught by DB/Profile) -->
        <div class="form-group">
          <label for="fname">First Name *</label>
          <input type="text" id="fname" name="fname" required>
        </div>
        <div class="form-group">
          <label for="lname">Last Name *</label>
          <input type="text" id="lname" name="lname" required>
        </div>
        <div class="form-group">
          <label for="email">Email Address *</label>
          <input type="email" id="email" name="email" required>
        </div>
        <div class="form-group">
          <label for="phone">Contact Number *</label>
          <input type="text" id="phone" name="phone" required>
        </div>
        <div class="form-group">
          <label for="exp">Total years of experience</label>
          <input type="text" id="exp" name="experience">
        </div>
        
        <!-- Dropdown / Select fields -->
        <div class="form-group">
          <label for="notice">What is your notice period?</label>
          <select id="notice" name="notice">
            <option value="">Select an option</option>
            <option value="immediate">Immediate</option>
            <option value="15">15 Days</option>
            <option value="30">30 Days</option>
            <option value="60">60 Days</option>
          </select>
        </div>

        <!-- Complex Radio Group -->
        <div class="form-group radio-group">
          <label>Are you willing to relocate to Pune?</label><br>
          <input type="radio" id="reloc_yes" name="relocate" value="Yes">
          <label for="reloc_yes">Yes, I can relocate</label>
          <input type="radio" id="reloc_no" name="relocate" value="No">
          <label for="reloc_no">No, I cannot</label>
        </div>

        <div class="form-group radio-group">
          <label>Do you have experience with Selenium?</label><br>
          <input type="radio" id="sel_yes" name="selenium" value="Yes">
          <label for="sel_yes">Yes</label>
          <input type="radio" id="sel_no" name="selenium" value="No">
          <label for="sel_no">No</label>
        </div>

        <!-- Novel/AI required fields -->
        <div class="form-group">
          <label for="tools">What testing tools and frameworks are you proficient in?</label>
          <textarea id="tools" name="tools" rows="3"></textarea>
        </div>
        
        <div class="form-group">
          <label for="why">Why do you want to join our company?</label>
          <textarea id="why" name="why" rows="3"></textarea>
        </div>

        <div class="form-group">
          <label for="salary">Expected CTC (LPA)</label>
          <input type="text" id="salary" name="salary">
        </div>

        <button type="submit" id="submit-btn">Submit Application</button>
      </form>
    </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log('Mock Job Portal running at http://localhost:' + port);
});
