import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, Modal, ScrollView, Alert } from 'react-native';
import { db } from '../services/firebase';
import { ref, onValue, update } from 'firebase/database';

export default function FlightScreen() {
  const [flights, setFlights] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [editingFlight, setEditingFlight] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    const configRef = ref(db, 'config/selectedDate');
    onValue(configRef, (snapshot) => {
      if (snapshot.exists()) {
        setSelectedDate(snapshot.val());
      }
    });
  }, []);

  useEffect(() => {
    const flightsRef = ref(db, `flightsByDate/${selectedDate}`);
    onValue(flightsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const list = Object.entries(data).map(([key, value]) => ({
          id: key,
          ...value,
        }));
        setFlights(list);
      } else {
        setFlights([]);
      }
    });
  }, [selectedDate]);

  const updateStatus = (flightId, newStatus) => {
    const flightRef = ref(db, `flightsByDate/${selectedDate}/${flightId}`);
    update(flightRef, { estado: newStatus })
      .then(() => {
        setModalVisible(false);
      })
      .catch((error) => {
        Alert.alert("Error", error.message);
      });
  };

  const renderFlightItem = ({ item }) => {
    const statusColor = getStatusColor(item.estado);
    return (
      <TouchableOpacity
        style={styles.flightCard}
        onPress={() => {
          setEditingFlight(item);
          setModalVisible(true);
        }}
      >
        <View style={styles.flightHeader}>
          <Text style={styles.vueloText}>{item.vuelo}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
            <Text style={styles.statusText}>{item.estado || 'ON'}</Text>
          </View>
        </View>
        <Text style={styles.destinoText}>{item.destino}</Text>
        <View style={styles.timeRow}>
          <View>
            <Text style={styles.timeLabel}>LLEGADA</Text>
            <Text style={styles.timeValue}>{item.llegada || '—'}</Text>
          </View>
          <View>
            <Text style={styles.timeLabel}>GATE</Text>
            <Text style={styles.timeValue}>{item.gate || '—'}</Text>
          </View>
          <View>
            <Text style={styles.timeLabel}>SALIDA</Text>
            <Text style={styles.timeValue}>{item.salida || '—'}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const getStatusColor = (status) => {
    switch (status?.toUpperCase()) {
      case 'ARRIVED': return '#22c55e';
      case 'DELAYED': return '#ef4444';
      case 'BOARDING': return '#3b82f6';
      case 'CANCELLED': return '#64748b';
      default: return '#eab308';
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Vuelos - {selectedDate}</Text>
      </View>
      <FlatList
        data={flights}
        renderItem={renderFlightItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
      />

      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Update Status: {editingFlight?.vuelo}</Text>
            <ScrollView style={styles.statusList}>
              {['ON', 'BOARDING', 'DELAYED', 'ARRIVED', 'DEPARTED', 'CANCELLED', 'DIVERTED'].map((status) => (
                <TouchableOpacity
                  key={status}
                  style={styles.statusButton}
                  onPress={() => updateStatus(editingFlight.id, status)}
                >
                  <Text style={styles.statusButtonText}>{status}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.closeButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  listContent: {
    padding: 15,
  },
  flightCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 15,
    marginBottom: 15,
    borderLeftWidth: 4,
    borderLeftColor: '#38bdf8',
  },
  flightHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  vueloText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  destinoText: {
    color: '#94a3b8',
    fontSize: 16,
    marginBottom: 12,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    paddingTop: 10,
  },
  timeLabel: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  timeValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '80%',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  statusList: {
    marginBottom: 20,
  },
  statusButton: {
    backgroundColor: '#334155',
    padding: 15,
    borderRadius: 10,
    marginBottom: 10,
    alignItems: 'center',
  },
  statusButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  closeButton: {
    padding: 15,
    alignItems: 'center',
  },
  closeButtonText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
