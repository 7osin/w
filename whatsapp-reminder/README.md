# WhatsApp Reminder Bot

This project is a WhatsApp Reminder Bot built using Node.js and the Baileys library. It allows users to send reminders via WhatsApp and provides a simple web interface for interaction.

## Features

- Connects to WhatsApp using the Baileys library.
- Sends messages to specified phone numbers.
- Displays a QR code for authentication.
- Keeps track of sent messages and displays them on the web interface.

## Installation

1. Clone the repository:

   ```
   git clone <repository-url>
   ```

2. Navigate to the project directory:

   ```
   cd whatsapp-reminder
   ```

3. Install the required dependencies:

   ```
   npm install
   ```

## Usage

1. Start the application:

   ```
   npm start
   ```

2. Open your web browser and go to `http://localhost:3000`.

3. Scan the QR code displayed on the web interface to authenticate with WhatsApp.

4. Enter the phone number and message you want to send, then click "Send Message".

## Dependencies

- **Express**: A web framework for Node.js.
- **Baileys**: A WhatsApp Web API library for Node.js.
- **Pino**: A logging library for Node.js.

## License

This project is licensed under the MIT License.