import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : "http://localhost:3000",
    methods: ["GET", "POST"] 
  }
});
// Configure NeonDB connection 
const pool = new Pool({
  connectionString:process.env.NEONDB_CONNECTION_STRING,
  ssl: {
    rejectUnauthorized: false // Required for NeonDB
  }
});

// Test the database connection
pool.connect()
  .then(client => {
    console.log('Connected to NeonDB');
    client.release();
  })
  .catch(err => {
    console.error('Error connecting to NeonDB:', err);
  });

// Create polls table if it doesn't exist
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS polls (
        id VARCHAR(36) PRIMARY KEY,
        question TEXT NOT NULL,
        options JSONB NOT NULL,
        time_limit INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP,
        is_active BOOLEAN NOT NULL,
        total_students INTEGER NOT NULL,
        total_votes INTEGER NOT NULL
      );
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

initializeDatabase();




app.use(cors());
app.use(express.json());


// In-memory storage 
let currentPoll = null;
let students = new Map(); 
let pollResults = new Map(); 
let chatMessages = []; 

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Teacher joins
  socket.on('join-as-teacher', () => {
    socket.join('teachers');
    socket.emit('current-poll', currentPoll);
    socket.emit('students-update', Array.from(students.values()));
    // Send chat history to teacher
    socket.emit('chat-history', chatMessages);
  });

  // Student joins
  socket.on('join-as-student', (studentData) => {
    const { studentId, name } = studentData;
    
    // Update or create student
    students.set(studentId, {
      id: studentId,
      name,
      socketId: socket.id,
      hasAnswered: currentPoll && currentPoll.isActive ? students.get(studentId)?.hasAnswered || false : false
    });

    socket.join('students');
    socket.studentId = studentId;
    
    // Send current poll to student
    socket.emit('current-poll', currentPoll);
    // Send chat history to student
    socket.emit('chat-history', chatMessages);
    
    // Update all teachers about students
    io.to('teachers').emit('students-update', Array.from(students.values()));
  });

  // Teacher creates a poll
  socket.on('create-poll', (pollData) => {
    // Allow creating a new poll if there's no current poll or if the current poll is not active
    if (currentPoll && currentPoll.isActive) {
      socket.emit('error', 'Cannot create poll while another is active');
      return;
    }

    const poll = {
      id: uuidv4(),
      question: pollData.question,
      options: pollData.options.map(option => ({
        id: uuidv4(),
        text: option,
        votes: 0
      })),
      timeLimit: pollData.timeLimit || 60,
      createdAt: Date.now(),
      isActive: true
    };

    currentPoll = poll;
    
    // Reset poll results
    pollResults.clear();
    poll.options.forEach(option => {
      pollResults.set(option.id, 0);
    });

    // Reset student answer status for new poll
    students.forEach(student => {
      student.hasAnswered = false;
    });

    // Send poll to all users
    io.emit('new-poll', poll);
    io.to('teachers').emit('students-update', Array.from(students.values()));
    
    console.log('New poll created:', poll.question);
  });

  // Student submits answer
  socket.on('submit-answer', (data) => {
    const { optionId } = data;
    const student = students.get(socket.studentId);
    
    if (!student || !currentPoll || !currentPoll.isActive || student.hasAnswered) {
      return;
    }

    // Mark student as answered
    student.hasAnswered = true;
    
    // Update poll results
    const currentCount = pollResults.get(optionId) || 0;
    pollResults.set(optionId, currentCount + 1);
    
    // Update poll options with new counts
    currentPoll.options = currentPoll.options.map(option => ({
      ...option,
      votes: pollResults.get(option.id) || 0
    }));

    // Send updated results to everyone
    io.emit('poll-results', {
      pollId: currentPoll.id,
      results: currentPoll.options,
      totalVotes: Array.from(pollResults.values()).reduce((a, b) => a + b, 0)
    });

    // Update teachers about student status
    io.to('teachers').emit('students-update', Array.from(students.values()));

    // Check if poll should end (all students answered)
    if (isPollCompleted()) {
      endCurrentPoll();
    }
  });

  // Teacher manually ends poll
  socket.on('end-poll', () => {
    if (currentPoll && currentPoll.isActive) {
      endCurrentPoll();
    }
  });

  // Get poll results
  socket.on('get-results', () => {
    if (currentPoll) {
      socket.emit('poll-results', {
        pollId: currentPoll.id,
        results: currentPoll.options,
        totalVotes: Array.from(pollResults.values()).reduce((a, b) => a + b, 0)
      });
    }
  });

  // Get poll history from database
  socket.on('get-poll-history', async () => {
    try {
      const result = await pool.query('SELECT * FROM polls ORDER BY created_at DESC LIMIT 10');
      socket.emit('poll-history', result.rows);
    } catch (err) {
      console.error('Error fetching poll history:', err);
      socket.emit('error', 'Failed to fetch poll history');
    }
  });

  // Teacher kicks student
  socket.on('kick-student', (studentId) => {
    const student = students.get(studentId);
    if (student) {
      io.to(student.socketId).emit('kicked');
      students.delete(studentId);
      io.to('teachers').emit('students-update', Array.from(students.values()));
    }
  });

  // Chat functionality
  socket.on('send-chat-message', (messageData) => {
    const message = {
      id: uuidv4(),
      sender: messageData.sender,
      message: messageData.message,
      timestamp: Date.now(),
      isTeacher: messageData.isTeacher
    };

    chatMessages.push(message);
    
    // Keep only last 100 messages
    if (chatMessages.length > 100) {
      chatMessages = chatMessages.slice(-100);
    }

    // Send message to all connected users immediately
    io.emit('chat-message', message);
    console.log('Chat message sent:', message.sender, ':', message.message);
  });

  socket.on('get-chat-history', () => {
    socket.emit('chat-history', chatMessages);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove student if they disconnect
    if (socket.studentId) {
      students.delete(socket.studentId);
      io.to('teachers').emit('students-update', Array.from(students.values()));
    }
  });
});

function isPollCompleted() {
  if (!currentPoll || !currentPoll.isActive) return false;
  
  const activeStudents = Array.from(students.values());
  return activeStudents.length > 0 && activeStudents.every(student => student.hasAnswered);
}

async function endCurrentPoll() {
  if (!currentPoll) return;
  
  console.log('Ending poll:', currentPoll.question);
  
  currentPoll.isActive = false;
  currentPoll.endedAt = Date.now();
  
  const totalVotes = Array.from(pollResults.values()).reduce((a, b) => a + b, 0);
  
  try {
    // Save poll to NeonDB
    await pool.query(
      `INSERT INTO polls (id, question, options, time_limit, created_at, ended_at, is_active, total_students, total_votes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        currentPoll.id,
        currentPoll.question,
        JSON.stringify(currentPoll.options),
        currentPoll.timeLimit,
        new Date(currentPoll.createdAt),
        new Date(currentPoll.endedAt),
        currentPoll.isActive,
        students.size,
        totalVotes
      ]
    );
    console.log('Poll saved to database');
  } catch (err) {
    console.error('Error saving poll to database:', err);
  }
  
  // Send final results to everyone
  io.emit('poll-results', {
    pollId: currentPoll.id,
    results: currentPoll.options,
    totalVotes: totalVotes
  });
  
  io.emit('poll-ended', currentPoll);
}

// Auto-end poll after time limit
setInterval(() => {
  if (currentPoll && currentPoll.isActive) {
    const timeElapsed = (Date.now() - currentPoll.createdAt) / 1000;
    if (timeElapsed >= currentPoll.timeLimit) {
      console.log('Auto-ending poll due to time limit');
      endCurrentPoll();
    }
  }
}, 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});